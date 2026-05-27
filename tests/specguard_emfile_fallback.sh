#!/usr/bin/env bash
set -euo pipefail

# Regression for the fallback path in spec-guard: close_range unavailable,
# /proc/self/fd initially unavailable because the inherited fd table is already
# at a lowered RLIMIT_NOFILE, and high-numbered descriptors still need closing.
# Run in a Linux image with static libc support, for example:
#   docker run --rm -v "$PWD:/work" -w /work alpine:latest sh -lc \
#     'apk add --no-cache bash build-base linux-headers >/dev/null && \
#      services/codeapi/tests/specguard_emfile_fallback.sh'

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

CC="${CC:-gcc}"
SPEC_GUARD_SRC="$ROOT/services/codeapi/api/src/spec-guard.c"

cat > "$TMP_DIR/fd_poison.c" <<'C'
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>
#include <unistd.h>

static void must_setrlimit(rlim_t soft, rlim_t hard) {
    struct rlimit rl = { .rlim_cur = soft, .rlim_max = hard };
    if (setrlimit(RLIMIT_NOFILE, &rl) != 0) {
        perror("setrlimit");
        exit(1);
    }
}

int main(int argc, char **argv) {
    if (argc != 3) {
        fprintf(stderr, "usage: fd_poison <spec-guard> <fd-report>\n");
        return 2;
    }

    must_setrlimit(4096, 4096);

    int opened = 0;
    for (int i = 0; i < 256; i++) {
        int fd = open("/dev/null", O_RDONLY);
        if (fd < 0) break;
        int flags = fcntl(fd, F_GETFD);
        if (flags >= 0) {
            fcntl(fd, F_SETFD, flags & ~FD_CLOEXEC);
        }
        opened++;
    }
    if (opened < 128) {
        fprintf(stderr, "opened only %d descriptors; regression setup is too weak\n", opened);
        return 3;
    }

    must_setrlimit(32, 4096);

    char *child_argv[] = { argv[1], argv[2], NULL };
    execv(argv[1], child_argv);
    perror("execv spec-guard");
    return 4;
}
C

cat > "$TMP_DIR/fd_report.c" <<'C'
#define _GNU_SOURCE
#include <dirent.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main(void) {
    DIR *d = opendir("/proc/self/fd");
    if (d == NULL) {
        perror("opendir");
        return 2;
    }

    int dir_fd = dirfd(d);
    int inherited = 0;
    int high = 0;
    int max_fd = -1;
    struct dirent *entry;
    while ((entry = readdir(d)) != NULL) {
        char *end = NULL;
        long fd = strtol(entry->d_name, &end, 10);
        if (end == entry->d_name || *end != '\0') continue;
        if (fd < 3 || fd > INT_MAX || (int)fd == dir_fd) continue;
        inherited++;
        if ((int)fd > max_fd) max_fd = (int)fd;
        if (fd >= 32) high++;
    }
    closedir(d);

    printf("inherited=%d high=%d max_fd=%d\n", inherited, high, max_fd);
    return high == 0 ? 0 : 42;
}
C

"$CC" -O2 -static -DSPEC_GUARD_TEST_DISABLE_CLOSE_RANGE \
    -o "$TMP_DIR/spec-guard" "$SPEC_GUARD_SRC"
"$CC" -O2 -static -o "$TMP_DIR/fd_poison" "$TMP_DIR/fd_poison.c"
"$CC" -O2 -static -o "$TMP_DIR/fd_report" "$TMP_DIR/fd_report.c"

"$TMP_DIR/fd_poison" "$TMP_DIR/spec-guard" "$TMP_DIR/fd_report"
