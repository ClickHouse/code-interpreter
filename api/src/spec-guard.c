#include <stdio.h>
#include <unistd.h>
#include <sys/prctl.h>

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

int main(int argc, char *argv[]) {
    if (argc < 2) {
        fprintf(stderr, "usage: spec-guard <command> [args...]\n");
        return 1;
    }

    prctl(PR_SET_SPECULATION_CTRL, PR_SPEC_STORE_BYPASS, PR_SPEC_FORCE_DISABLE, 0, 0);
    prctl(PR_SET_SPECULATION_CTRL, PR_SPEC_INDIRECT_BRANCH, PR_SPEC_FORCE_DISABLE, 0, 0);

    execvp(argv[1], &argv[1]);
    perror("exec");
    return 1;
}
