"""
spec-guard FD isolation regression test.

Reproduces the audit's "permanent sandbox brick" pattern:

    1. A first /api/v2/execute opens N socket FDs against /tmp/tcs.sock
       and never closes them (simulates malicious sandbox code).
    2. After the first job exits, the runner's per-job FD slot bookkeeping
       is supposed to be back to baseline.
    3. A SECOND /api/v2/execute runs trivial Python and reports its
       inherited FD count via /proc/self/fd.

Without `spec-guard` closing inherited descriptors before `execvp()`, the
second job's user process starts with whatever FDs leaked through the
runner -> NsJail -> child chain. With the fix, the second job's Python
process sees only stdin/stdout/stderr (plus whatever it itself opens).

The test asserts BOTH:
  - The simulated leak in job 1 actually opens many FDs.
  - The follow-up job 2 starts with a clean FD table (<= a small bound).

Usage (local docker compose stack):

    SANDBOX_REQUIRE_EGRESS_MANIFEST=false CODEAPI_HARDENED_SANDBOX_MODE=false \\
        docker compose up -d
    python3 services/codeapi/tests/specguard_fd_isolation.py
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

SANDBOX_URL = os.environ.get("SANDBOX_URL", "http://127.0.0.1:2000")
REQUEST_TIMEOUT_S = float(os.environ.get("SPEC_GUARD_TEST_TIMEOUT_S", "30"))

# After spec-guard runs and the user's Python interpreter starts, a tiny
# number of FDs are legitimately open: 0/1/2 plus whatever Python opened
# during startup (typically the dirfd it iterates /proc/self/fd through).
# Anything above this bound is leaked descriptors.
MAX_LEGITIMATE_INHERITED_FDS = 10


def execute(language: str, code: str, timeout_ms: int = 15_000) -> dict:
    body = {
        "language": language,
        "version": "*",
        "files": [{"name": "main.py" if language == "python" else "main.sh",
                   "content": code}],
        "stdin": "",
        "args": [],
        "run_timeout": timeout_ms,
    }
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        f"{SANDBOX_URL}/api/v2/execute",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as resp:
        return json.loads(resp.read().decode("utf-8"))


STORM_TARGET = 500
"""Open many more connections than the proxy's maxConnections cap (64 by
default). The kernel queues some (listen backlog) and accepts the rest as
slots free up via the proxy's idle timer. This matches the audit's
literal red-team script — `for i in range(500): connect(); leak`. Without
this volume, the test wouldn't exercise the steady-state-pressure path
the audit broke on. The storm job exits without closing any of them; the
proxy must reclaim accept-side FDs and the runner must remain serviceable."""

MIN_STORM_OPENED = 200
"""Lower bound on what the storm job must successfully open before we
trust the test was meaningful. Without this assertion the test would
silently degrade — if the proxy ever started refusing all connections
at the kernel layer, the storm would open 0 sockets, the FD-poisoning
preconditions would never be exercised, and the regression would still
report PASS. 200 is comfortably above the production cap of 64 so the
kernel accept queue + proxy reaping cycle is exercised."""


def fd_storm_then_report() -> None:
    """First job: open many connections to /tmp/tcs.sock and never close them.
    The connections live until the user process exits — but the proxy and
    runner-side accounting may retain state. Spec-guard must not let any of
    that leak into the NEXT job's process."""
    code = (
        "import os, socket, json\n"
        # The runner bind-mounts the proxy socket at this fixed path; the
        # TOOL_CALL_SOCKET env var was dropped to keep the path off
        # `os.environ`, so the test references the literal path instead.
        "s = '/tmp/tcs.sock'\n"
        "leaked = []\n"
        "errors = []\n"
        # Append every socket to a list so CPython's refcount keeps the FD
        # alive until process exit. Without this, each loop iteration
        # rebinds `sk` and the previous socket is GC'd before the next
        # connect() runs — the loop reports `opened == STORM_TARGET` but
        # only ONE FD is ever actually held, so the FD-poisoning
        # preconditions the test exists to exercise are never created.
        f"for _ in range({STORM_TARGET}):\n"
        "    try:\n"
        "        sk = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)\n"
        "        sk.connect(s); leaked.append(sk)\n"
        "    except OSError as e:\n"
        "        errors.append(str(e)); break\n"
        # Read /proc/self/fd to PROVE we're actually holding `opened` FDs
        # concurrently, so the assertion downstream isn't satisfied by
        # the loop counter alone.
        "concurrent_fds = len([x for x in os.listdir('/proc/self/fd') if x.isdigit()])\n"
        "print(json.dumps({'opened': len(leaked), 'concurrent_fds': concurrent_fds, "
        "'target': "
        + str(STORM_TARGET) + ", 'errors': errors[:3]}))\n"
    )
    result = execute("python", code)
    run = result.get("run") or {}
    if run.get("code") != 0:
        print(f"FAIL: storm job exited non-zero: {run!r}", file=sys.stderr)
        sys.exit(1)
    stdout = (run.get("stdout") or "").strip()
    print(f"[storm-job] {stdout}")
    last_line = stdout.splitlines()[-1] if stdout else ""
    try:
        payload = json.loads(last_line)
    except json.JSONDecodeError:
        print(
            f"FAIL: storm job did not produce JSON status line; got {last_line!r}",
            file=sys.stderr,
        )
        sys.exit(1)
    opened = int(payload.get("opened", 0))
    concurrent = int(payload.get("concurrent_fds", 0))
    if opened < MIN_STORM_OPENED:
        print(
            f"FAIL: storm job opened only {opened} sockets (required >= "
            f"{MIN_STORM_OPENED}); the FD-poisoning preconditions were not "
            f"exercised, so a downstream PASS would be vacuous. errors: "
            f"{payload.get('errors')}",
            file=sys.stderr,
        )
        sys.exit(1)
    # Defend against the "vacuous pass via socket reuse" mode — assert
    # the storm process is actually HOLDING the FDs concurrently in
    # /proc/self/fd, not just opening-then-closing in a loop.
    if concurrent < MIN_STORM_OPENED:
        print(
            f"FAIL: storm job reported {opened} opens but /proc/self/fd "
            f"shows only {concurrent} concurrent FDs — sockets are being "
            f"GC'd between iterations and the test is vacuous.",
            file=sys.stderr,
        )
        sys.exit(1)


def report_inherited_fd_count() -> int:
    """Second job: introspect /proc/self/fd. Spec-guard should have closed
    everything but stdin/out/err before this Python invocation began."""
    code = (
        "import os, json\n"
        "fds = sorted(int(x) for x in os.listdir('/proc/self/fd') if x.isdigit())\n"
        "print(json.dumps({'fd_count': len(fds), 'fds': fds[:20]}))\n"
    )
    result = execute("python", code)
    run = result.get("run") or {}
    if run.get("code") != 0:
        print(f"FAIL: report job exited non-zero: {run!r}", file=sys.stderr)
        sys.exit(1)
    stdout = (run.get("stdout") or "").strip()
    print(f"[report-job] {stdout}")
    payload = json.loads(stdout.split("\n")[-1])
    return int(payload["fd_count"])


def post_storm_recovery() -> int:
    """The audit's specific failure: after a socket storm, subsequent
    dynamic-binary executions (python/node/bash/bun) failed during
    library-load with `Error 24` (EMFILE). Run a real exec in each
    language and require code 0 — proves the dynamic loader is no
    longer poisoned by inherited descriptors."""
    cases = [
        ("python", "import sys; print('python', sys.version_info[:3])"),
        ("node",   "console.log('node', process.version)"),
        ("bash",   "echo bash $(/bin/bash --version | head -1)"),
    ]
    failed = 0
    for lang, code in cases:
        result = execute(lang, code)
        run = result.get("run") or {}
        out = (run.get("stdout") or "").strip()
        err = (run.get("stderr") or "").strip()
        ok = run.get("code") == 0 and out and not err
        marker = "ok " if ok else "FAIL"
        print(f"  [{marker}] {lang:6} code={run.get('code')!r:>4} stdout={out!r:<50} stderr={err[:80]!r}")
        if not ok:
            failed += 1
        # Specifically guard against the audit's EMFILE-on-loader pattern
        if "Error 24" in err or "Too many open files" in err:
            print(f"       ^ audit-mode regression: dynamic loader hit EMFILE")
            failed += 1
    return failed


def ptc_route_opacity_check() -> bool:
    """Probe the proxy at /tool-call (with no PTC headers) and at unknown
    paths from inside the sandbox; both must produce BYTE-IDENTICAL wire
    responses, otherwise an attacker can still fingerprint the real route
    by reading the response framing (ETag, X-Request-ID, charset, etc.).
    The original audit broke on this exact gap — the response BODY matched
    but the upstream's Express-added headers leaked through the proxy."""
    code = (
        "import os, socket, json\n"
        # Same fixed-path reasoning as fd_storm_then_report().
        "s = '/tmp/tcs.sock'\n"
        "responses = {}\n"
        "for path in ['/tool-call', '/randomroute']:\n"
        "    sk = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)\n"
        "    sk.connect(s)\n"
        "    sk.sendall(('POST ' + path + ' HTTP/1.1\\r\\nHost: x\\r\\n"
        "Content-Length: 0\\r\\nConnection: close\\r\\n\\r\\n').encode())\n"
        "    buf = b''\n"
        "    while True:\n"
        "        chunk = sk.recv(4096)\n"
        "        if not chunk: break\n"
        "        buf += chunk\n"
        "    sk.close()\n"
        "    # Strip the volatile Date header before comparing\n"
        "    lines = buf.split(b'\\r\\n')\n"
        "    filtered = b'\\r\\n'.join(l for l in lines if not l.lower().startswith(b'date:'))\n"
        "    responses[path] = filtered.decode('utf-8', 'replace')\n"
        "print(json.dumps(responses))\n"
    )
    result = execute("python", code)
    run = result.get("run") or {}
    if run.get("code") != 0:
        print(f"FAIL: opacity probe exited non-zero: {run!r}", file=sys.stderr)
        return False
    payload = json.loads((run.get("stdout") or "").splitlines()[-1])
    tc, rr = payload["/tool-call"], payload["/randomroute"]
    if tc == rr:
        print(f"  [ok ] /tool-call response is byte-identical to /randomroute "
              f"({len(tc)} bytes)")
        return True
    print(f"  [FAIL] wire responses differ — sandbox can fingerprint the route:")
    print(f"    /tool-call:    {tc!r}")
    print(f"    /randomroute:  {rr!r}")
    return False


def main() -> int:
    print(f"=== spec-guard FD isolation regression — runner: {SANDBOX_URL} ===")
    print(f"step 1: open {STORM_TARGET} socket FDs in a first job (audit's exact red-team script)")
    fd_storm_then_report()
    print("step 2: launch a second job and report its inherited FD count")
    fd_count = report_inherited_fd_count()
    print(f"  -> second job sees {fd_count} FDs (bound: {MAX_LEGITIMATE_INHERITED_FDS})")
    if fd_count > MAX_LEGITIMATE_INHERITED_FDS:
        print(
            f"FAIL: second job inherited {fd_count} FDs — "
            f"spec-guard did NOT close inherited descriptors before execvp",
            file=sys.stderr,
        )
        return 1
    print("step 3: post-storm recovery for python / node / bash")
    failed = post_storm_recovery()
    if failed:
        print(f"FAIL: {failed} language(s) regressed", file=sys.stderr)
        return 1
    print("step 4: PTC route opacity (byte-identical 404 wire responses)")
    if not ptc_route_opacity_check():
        return 1
    print("PASS: spec-guard isolated the second job's FD table, "
          "all runtimes recovered post-storm, and the /tool-call route "
          "is wire-indistinguishable from any unknown path")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except urllib.error.HTTPError as exc:
        print(f"HTTPError {exc.code}: {exc.read()[:300]!r}", file=sys.stderr)
        sys.exit(2)
    except urllib.error.URLError as exc:
        print(f"URLError: {exc}", file=sys.stderr)
        sys.exit(2)
