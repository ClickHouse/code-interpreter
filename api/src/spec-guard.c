#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef PR_SET_SPECULATION_CTRL
#define PR_SET_SPECULATION_CTRL 53
#endif
#ifndef PR_SPEC_STORE_BYPASS
#define PR_SPEC_STORE_BYPASS 0
#endif
#ifndef PR_SPEC_INDIRECT_BRANCH
#define PR_SPEC_INDIRECT_BRANCH 1
#endif
#ifndef PR_SPEC_FORCE_DISABLE
#define PR_SPEC_FORCE_DISABLE 8
#endif

#ifndef __NR_close_range
#  if defined(__x86_64__)
#    define __NR_close_range 436
#  elif defined(__aarch64__)
#    define __NR_close_range 436
#  endif
#endif

/* Close every file descriptor >= 3 (preserve stdin/stdout/stderr) before
 * the user command runs. The bug this prevents:
 *
 *   (1) sandbox API / proxy / NsJail allocate FDs in the runner;
 *   (2) NsJail forks a child to run the user command;
 *   (3) any FD without O_CLOEXEC is INHERITED by the child;
 *   (4) the child's RLIMIT_NOFILE counts those inherited slots, so a
 *       runner-side FD storm leaves the child starting in a poisoned
 *       state — the dynamic loader hits EMFILE before user code runs:
 *           "error while loading shared libraries: libc.so.6: cannot
 *            close file descriptor: Error 24"
 *
 * Closing here, on the wrong side of execvp, is the cheapest containment.
 * Every user command in the sandbox already passes through spec-guard,
 * so this is the right choke point regardless of which producer leaked.
 *
 * Order of attempts:
 *   1. close_range(3, ~0U, 0)  (Linux 5.9+; one syscall, fastest)
 *   2. /proc/self/fd walk      (only closes actually-open FDs; cheap)
 *   3. RLIMIT_NOFILE loop      (last resort; may iterate millions)
 */
static void close_inherited_fds(void) {
#ifdef __NR_close_range
    long rc = syscall(__NR_close_range, (unsigned int)3, ~0U, 0u);
    if (rc == 0) return;
    /* ENOSYS on pre-5.9 kernels, EINVAL on some odd builds. Fall through. */
#endif

    DIR *d = opendir("/proc/self/fd");
    if (d != NULL) {
        int dir_fd = dirfd(d);
        struct dirent *entry;
        while ((entry = readdir(d)) != NULL) {
            if (entry->d_name[0] == '.') continue;
            char *end = NULL;
            long fd = strtol(entry->d_name, &end, 10);
            if (end == entry->d_name || *end != '\0') continue;
            if (fd < 3 || fd > (long)INT_MAX) continue;
            if ((int)fd == dir_fd) continue;  /* don't close our iterator */
            close((int)fd);
        }
        closedir(d);
        return;
    }

    /* No /proc — uncommon but possible. Bound the loop by RLIMIT_NOFILE.
     * Avoids spinning to 2^31 on systems with no rlimit. */
    struct rlimit rl;
    long max_fd = 1024;
    if (getrlimit(RLIMIT_NOFILE, &rl) == 0
        && rl.rlim_cur != RLIM_INFINITY
        && rl.rlim_cur <= 1048576) {
        max_fd = (long)rl.rlim_cur;
    }
    for (int fd = 3; fd < (int)max_fd; fd++) {
        close(fd);
    }
}

int main(int argc, char *argv[]) {
    if (argc < 2) {
        fprintf(stderr, "usage: spec-guard <command> [args...]\n");
        return 1;
    }

    prctl(PR_SET_SPECULATION_CTRL, PR_SPEC_STORE_BYPASS, PR_SPEC_FORCE_DISABLE, 0, 0);
    prctl(PR_SET_SPECULATION_CTRL, PR_SPEC_INDIRECT_BRANCH, PR_SPEC_FORCE_DISABLE, 0, 0);

    umask(0077);

    close_inherited_fds();

    execvp(argv[1], &argv[1]);
    perror("exec");
    return 1;
}
