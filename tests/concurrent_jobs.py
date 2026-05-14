"""
Concurrent-jobs reproducer for the sandbox-runner NsJail mount-setup race.

Burst-fires N parallel bash jobs at the runner and tallies failure modes. The
race we are hunting is two NsJail children both targeting `/tmp/nsjail.0.root`
inside the same microVM, which shows up as:

  - NsJail exit 255 ("nsjail failed to setup")
  - workspace ENOENT inside `/mnt/data`
  - chown EPERM on `/tmp/sandbox` (workspace root)

Run against the KVM-enabled local stack so you are exercising the real
launcher -> krun -> microVM -> bun api -> NsJail path that production uses;
the mac / KVM-disabled overlay short-circuits the microVM and would test a
different code path:

    cd services/codeapi
    SANDBOX_REQUIRE_EGRESS_MANIFEST=false docker compose up -d
    # confirm KVM is on: `docker exec sandbox-runner ls -l /dev/kvm`
    python3 tests/concurrent_jobs.py 16
    python3 tests/concurrent_jobs.py 32
    python3 tests/concurrent_jobs.py 64

To prove the fix isolates the race, run the burst once on the current
nsjail.ts (with the setup gate), then revert nsjail.ts to HEAD~ and re-run.
The pre-fix run should surface the symptoms above; the post-fix run should
be clean. SANDBOX_REQUIRE_EGRESS_MANIFEST=false skips manifest signing so
the burst exercises only the runner setup window, not auth.

Exits non-zero if any job returned non-2xx, a non-JSON body, or a body that
matches a known race symptom. Treats this as a regression test: a green run
means the runner survived the burst.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from dataclasses import dataclass
from typing import Any

import aiohttp


SANDBOX_URL = os.environ.get("SANDBOX_URL", "http://127.0.0.1:2000")
REQUEST_TIMEOUT_S = float(os.environ.get("CONCURRENT_JOBS_TIMEOUT_S", "60"))

# Symptom patterns we expect to disappear once the setup race is fixed.
RACE_SYMPTOMS = (
    "nsjail.0.root",
    "nsjail exit 255",
    "EPERM",
    "operation not permitted",
    "ENOENT",
    "no such file or directory",
    "mount",
)


def job_payload(i: int) -> dict[str, Any]:
    """Minimal bash job. Trivial work keeps execution time short so the burst
    is dominated by setup, which is the dangerous phase we are stressing."""
    return {
        "language": "bash",
        "version": "*",
        "files": [
            {
                "name": "main.sh",
                # Echo enough state to confirm each job got its own workspace.
                "content": f'echo "job {i} pid=$$ ws=$(pwd) ts=$(date +%s%N)"',
            }
        ],
        "stdin": "",
        "args": [],
        "run_timeout": 5000,
    }


@dataclass
class JobResult:
    index: int
    http_status: int | None
    body_text: str
    body_json: dict[str, Any] | None
    duration_ms: float
    error: str | None


def classify(result: JobResult) -> tuple[str, str | None]:
    """Returns (category, symptom). category in:
    - success: 2xx with a parseable JSON body and run.code == 0
    - run_error: 2xx with JSON body but the inner program returned non-zero
      (still a healthy runner — user code legitimately failed)
    - http_2xx_non_json: 2xx but the body did not parse as JSON, or parsed
      to JSON without the expected run/compile fields. Treated as a failure
      because the runner always emits a structured response on the happy
      path; a plain-text/HTML 2xx (proxy interstitial, gateway error page,
      etc.) silently masking a regression is exactly what we don't want.
    - http_5xx_blank: 5xx with no body — the symptom the user reported
    - http_5xx_body: 5xx with a body (JSON or otherwise)
    - http_other: any other non-2xx (3xx, 4xx)
    - exception: transport error / timeout
    """
    if result.error is not None:
        return "exception", result.error
    if result.http_status is None:
        return "exception", "no status"
    if 200 <= result.http_status < 300:
        if result.body_json is None:
            preview = result.body_text[:120] if result.body_text else "(empty body)"
            return "http_2xx_non_json", f"non-JSON 2xx: {preview!r}"
        run = result.body_json.get("run") or result.body_json.get("compile")
        if run is None:
            return "http_2xx_non_json", "JSON 2xx missing run/compile fields"
        if run.get("code") not in (0, None):
            return "run_error", f'code={run.get("code")}'
        return "success", None
    if 500 <= result.http_status < 600:
        if not result.body_text.strip():
            return "http_5xx_blank", "empty body"
        return "http_5xx_body", result.body_text[:240]
    return "http_other", f"status={result.http_status}"


def find_race_symptom(text: str) -> str | None:
    lower = text.lower()
    for needle in RACE_SYMPTOMS:
        if needle.lower() in lower:
            return needle
    return None


async def fire_one(session: aiohttp.ClientSession, i: int) -> JobResult:
    payload = job_payload(i)
    start = time.perf_counter()
    try:
        async with session.post(
            f"{SANDBOX_URL}/api/v2/execute",
            json=payload,
            timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT_S),
        ) as resp:
            text = await resp.text()
            duration_ms = (time.perf_counter() - start) * 1000
            try:
                body_json = json.loads(text) if text else None
            except json.JSONDecodeError:
                body_json = None
            return JobResult(
                index=i,
                http_status=resp.status,
                body_text=text,
                body_json=body_json,
                duration_ms=duration_ms,
                error=None,
            )
    except Exception as err:  # noqa: BLE001 — we want any transport failure
        duration_ms = (time.perf_counter() - start) * 1000
        return JobResult(
            index=i,
            http_status=None,
            body_text="",
            body_json=None,
            duration_ms=duration_ms,
            error=f"{type(err).__name__}: {err}",
        )


async def burst(n: int) -> list[JobResult]:
    connector = aiohttp.TCPConnector(limit=0)
    async with aiohttp.ClientSession(connector=connector) as session:
        tasks = [asyncio.create_task(fire_one(session, i)) for i in range(n)]
        return await asyncio.gather(*tasks)


def report(results: list[JobResult]) -> int:
    buckets: dict[str, list[JobResult]] = {}
    symptoms: dict[str, int] = {}
    for r in results:
        category, detail = classify(r)
        buckets.setdefault(category, []).append(r)
        body_for_match = r.body_text or (r.error or "")
        symptom = find_race_symptom(body_for_match)
        if symptom:
            symptoms[symptom] = symptoms.get(symptom, 0) + 1

    total = len(results)
    success = len(buckets.get("success", []))
    run_error = len(buckets.get("run_error", []))
    durations = sorted(r.duration_ms for r in results)
    p50 = durations[len(durations) // 2] if durations else 0.0
    p95 = durations[int(len(durations) * 0.95)] if durations else 0.0

    print(f"\n=== concurrent_jobs n={total} url={SANDBOX_URL} ===")
    print(f"  success      : {success}")
    print(f"  run_error    : {run_error}")
    for cat in ("http_2xx_non_json", "http_5xx_blank", "http_5xx_body", "http_other", "exception"):
        items = buckets.get(cat, [])
        if not items:
            continue
        print(f"  {cat:<13}: {len(items)}")
        for r in items[:3]:
            preview = r.error or r.body_text[:120] or "(no body)"
            print(f"      - job {r.index} status={r.http_status} {preview!r}")
        if len(items) > 3:
            print(f"      ... and {len(items) - 3} more")
    print(f"  latency ms   : p50={p50:.0f}  p95={p95:.0f}  max={durations[-1]:.0f}")
    if symptoms:
        print(f"  race symptoms detected:")
        for needle, count in sorted(symptoms.items(), key=lambda kv: -kv[1]):
            print(f"      {needle!r}: {count}")

    failed = total - success - run_error
    if failed > 0 or symptoms:
        print(f"\nFAIL: {failed} setup-side failures, {sum(symptoms.values())} race symptom hits")
        return 1
    print("\nPASS")
    return 0


def main() -> int:
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 16
    if n < 1:
        print("n must be >= 1", file=sys.stderr)
        return 2
    results = asyncio.run(burst(n))
    return report(results)


if __name__ == "__main__":
    sys.exit(main())
