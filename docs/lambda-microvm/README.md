# Stateful Code Sessions on AWS Lambda MicroVMs

This directory documents and provisions the **optional** AWS Lambda MicroVM
execution backend for the CodeAPI sandbox. It turns the semi-stateless Code
Interpreter into one that offers **perceived-indefinite stateful sessions**: a
warm per-session workspace plus checkpoint/restore across the VM's 8-hour
lifetime, without changing the default HTTP behavior.

- Config reference and knobs → below.
- One-command AWS prerequisites → [`terraform/`](./terraform).
- Image build helper → [`../../service/scripts/create-microvm-image.ts`](../../service/scripts/create-microvm-image.ts).
- Design deep-dive → [`../aws-lambda-microvm-stateful-sessions-report.md`](../aws-lambda-microvm-stateful-sessions-report.md).

> This is a config-gated feature. With `CODEAPI_SANDBOX_BACKEND` unset, nothing
> here is active and the sandbox behaves exactly as before.

---

## The cross-repo picture

Stateful sessions span three repos. Each owns one layer, and they degrade
gracefully out of order (the wire fields are additive and ignored when absent).

| Repo | Provides | Key artifact |
|---|---|---|
| **code-interpreter** (this repo) | The Code API service + the Lambda MicroVM backend, the runner's persistent workspace, checkpoint/restore, and the session registry. Owns **all** AWS config. | `CODEAPI_SANDBOX_BACKEND=lambda-microvm` |
| **@librechat/agents** | The SDK surface: `toolExecution.sandbox.statefulSessions` and the `statefulSessions` tool-factory param. Stamps a per-conversation session hint on `/exec`. | `runtime_session_hint` on the wire |
| **LibreChat** | The `stateful_code_sessions` app capability + a per-agent Agent Builder toggle, wired into `createRun`. | endpoints.agents capability + agent toggle |

**Trust boundary:** LibreChat and the agents SDK never learn any AWS
configuration. They speak the same `/exec` HTTP protocol as always, plus one
optional `runtime_session_hint` field. Everything AWS — backend selection, the
image ARN, roles, connectors, the checkpoint bucket, credentials — lives only in
this service's environment. An operator can switch this service between `http`
and `lambda-microvm` (or run with no AWS at all) with zero changes upstream.

---

## How a request flows

```
agent tool call
      │  POST /exec  (+ optional runtime_session_hint)
      ▼
CodeAPI service ── derive runtime_session_id = hash(tenant, user, hint)
      │                       │
      │            Redis session registry (SET NX lock, generation fence)
      ▼                       │
SandboxBackend (lambda-microvm)
      │  find-or-launch ONE MicroVM per runtime_session_id
      ▼
RunMicrovm ─► warm VM ─► CreateMicrovmAuthToken ─► POST /api/v2/execute
      │                     (X-Runtime-Session-Id header = session mode on)
      ▼
runner reuses ONE /mnt/data workspace across calls
      │  post-exec, lock held: checkpoint /mnt/data ──► S3
      ▼
restore-on-relaunch: a replacement VM pulls the S3 checkpoint before first exec
```

Two independent planes: **presentation/orchestration** (the registry + backend,
which own identity and durability) and **compute** (the MicroVM, which is a cheap,
disposable, resumable cache). The VM can die at any time; the session survives.

---

## Prerequisites

- An AWS account with **Lambda MicroVMs available** in your region (a new
  service; confirm regional availability first). No default region is assumed —
  every call passes one explicitly.
- **AWS CLI ≥ 2.35** if you want to poke the `aws lambda-microvms` CLI directly
  (older CLIs lack the commands). The scripted image build uses the JS SDK and
  doesn't need a recent CLI.
- Terraform ≥ 1.5 for the prerequisites module.
- Docker with `buildx` (arm64) to build the runner image.
- Redis (the CodeAPI service already depends on it) for the session registry.
- An S3-compatible store for checkpoints (real S3 in prod; MinIO for local dev).

---

## Quick start (from scratch)

### 1. Provision AWS prerequisites (Terraform)

```bash
cd docs/lambda-microvm/terraform
cp terraform.tfvars.example terraform.tfvars   # edit region, name_prefix, image_name
terraform init && terraform apply
```

This creates the checkpoint bucket (encrypted, versioned, lifecycle-expired), an
artifact bucket, the **build role** (trust includes `sts:TagSession`; perms
include `logs:*` + `s3:GetObject` + optional ECR pull), a **logging-only
execution role**, and the build + runtime CloudWatch log groups. Capture the
outputs:

```bash
terraform output          # build_role_arn, execution_role_arn, checkpoint_bucket, artifact_bucket, ...
```

### 2. Build + push the runner image, upload the code-artifact

```bash
cd ../../..                     # repo root
export AWS_PROFILE=... AWS_REGION=us-east-1
export ECR_URI=<acct>.dkr.ecr.us-east-1.amazonaws.com/codeapi-microvm-runner
export S3_URI=s3://$(terraform -chdir=docs/lambda-microvm/terraform output -raw artifact_bucket)/runner
export IMAGE_TAG=$(git rev-parse --short HEAD)
scripts/build-lambda-microvm-artifact.sh build push zip upload
# → uploads s3://<artifact-bucket>/runner/runner-<tag>.zip
```

The runner image target is `lambda-microvm-runner` in `api/Dockerfile`
(`FROM sandbox-build` + `/pkgs`, `PORT=8080`, `SANDBOX_SESSION_WORKSPACE_ENABLED=true`).

### 3. Create the MicroVM image (hookless)

```bash
cd service
AWS_PROFILE=... bun scripts/create-microvm-image.ts \
  --name codeapi-session \
  --artifact s3://<artifact-bucket>/runner/runner-<tag>.zip \
  --build-role $(terraform -chdir=../docs/lambda-microvm/terraform output -raw build_role_arn) \
  --region us-east-1
# → prints LAMBDA_MICROVM_IMAGE_ARN when CREATED (~3-5 min)
```

The helper builds hookless with `additionalOsCapabilities:["ALL"]` and
`SANDBOX_USE_CGROUPV2=false` baked in — the working config (see
[Runbook gotchas](#runbook-gotchas)). To ship new runner code later, re-run
`build … push zip upload` and call the helper with `--update`.

### 4. Configure the CodeAPI service

```bash
CODEAPI_SANDBOX_BACKEND=lambda-microvm
CODEAPI_RUNTIME_SESSION_MODE=affinity          # warm sessions + checkpoints
LAMBDA_MICROVM_IMAGE_ARN=<from step 3>
LAMBDA_MICROVM_EXECUTION_ROLE_ARN=<terraform execution_role_arn>
LAMBDA_MICROVM_REGION=us-east-1
LAMBDA_MICROVM_INGRESS_CONNECTOR_ARNS=arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:ALL_INGRESS
LAMBDA_MICROVM_EGRESS_CONNECTOR_ARNS=arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:INTERNET_EGRESS

# checkpoints (S3-compatible, same client as file-server)
CODEAPI_CHECKPOINT_BUCKET=<terraform checkpoint_bucket>
MINIO_ENDPOINT=s3.us-east-1.amazonaws.com
MINIO_PORT=443           # required: the client defaults to 9000, which fails against S3
MINIO_USE_SSL=true
MINIO_REGION=us-east-1
MINIO_ACCESS_KEY=...    # from your CodeAPI task role, or the optional TF IAM user
MINIO_SECRET_KEY=...
```

`PTC_MODE` must be `replay` (the default) or unset — see
[Programmatic Tool Calling](#programmatic-tool-calling-ptc).

### 5. Verify

Enable the capability + per-agent toggle in LibreChat and run a two-message
conversation: write `42` to `/mnt/data/answer.txt`, then read it back in a
follow-up message. With the session backend it reads `42`; with the toggle off,
the follow-up sees no file. (The LibreChat PR documents the full acceptance test
and the no-infra wiring smoke.)

---

## Configuration reference

All names as they appear in `service/src/config.ts`.

### Backend selection

| Env | Default | Meaning |
|---|---|---|
| `CODEAPI_SANDBOX_BACKEND` | `http` | `http` (byte-identical to today) or `lambda-microvm`. |
| `CODEAPI_RUNTIME_SESSION_MODE` | `stateless` | `stateless` \| `affinity` \| `strict`. See [Operating modes](#operating-modes). |
| `CODEAPI_RUNTIME_SESSION_LOCK_WAIT_MS` | `15000` | How long an execution waits for the session lock before falling back (affinity) or erroring (strict). |

### MicroVM launch

| Env | Default | Meaning |
|---|---|---|
| `LAMBDA_MICROVM_IMAGE_ARN` | — (required) | The image created in step 3. |
| `LAMBDA_MICROVM_IMAGE_VERSION` | latest | Pin a specific image version. |
| `LAMBDA_MICROVM_EXECUTION_ROLE_ARN` | — | Logging-only role. Required for runtime VM stdout to reach CloudWatch. |
| `LAMBDA_MICROVM_REGION` | SDK default | Region for the lambda-microvms client. |
| `LAMBDA_MICROVM_INGRESS_CONNECTOR_ARNS` | — | Comma-separated. Inbound HTTPS to the VM. |
| `LAMBDA_MICROVM_EGRESS_CONNECTOR_ARNS` | — | Comma-separated. Outbound from the VM. Required in hardened mode. |
| `LAMBDA_MICROVM_PORT` | `8080` | Runner port. |
| `LAMBDA_MICROVM_MAX_DURATION_SECONDS` | `28800` | Hard lifetime ceiling (≤ 8h). |
| `LAMBDA_MICROVM_IDLE_SECONDS` | `300` | idlePolicy: auto-suspend after this idle. |
| `LAMBDA_MICROVM_SUSPEND_SECONDS` | `1800` | idlePolicy: auto-terminate after this suspended. |
| `LAMBDA_MICROVM_AUTH_TOKEN_TTL_SECONDS` | `300` | Proxy auth token TTL (cached to 80%). |
| `LAMBDA_MICROVM_LAUNCH_TIMEOUT_MS` | `60000` | Budget for RunMicrovm → RUNNING. |
| `LAMBDA_MICROVM_HEALTH_TIMEOUT_MS` | `5000` | Health check budget. |
| `LAMBDA_MICROVM_LAUNCH_TPS` / `_RESUME_TPS` / `_SUSPEND_TPS` | `4` / `4` / `1` | Client-side throttle (headroom under AWS's 5/5/2 caps). |
| `LAMBDA_MICROVM_ALLOW_SHELL` | `false` | Must stay false in prod (shell auth token → IAM-deny). |

### Checkpoints (affinity/strict only)

| Env | Default | Meaning |
|---|---|---|
| `CODEAPI_SESSION_CHECKPOINTS` | `true` | `false` disables checkpoint/restore (sessions still reuse a warm workspace, but expiry recovery falls back to file-refs). |
| `CODEAPI_CHECKPOINT_BUCKET` | `MINIO_BUCKET` | Checkpoint bucket. |
| `CODEAPI_CHECKPOINT_PREFIX` | `rtsx-checkpoints/` | Key prefix. Objects are `<prefix><runtime_session_id>.tar.gz`. |
| `CODEAPI_CHECKPOINT_MAX_BYTES` | `536870912` | Max checkpoint size (512 MiB). |
| `CODEAPI_CHECKPOINT_TIMEOUT_MS` | `60000` | Checkpoint transfer budget. |
| `MINIO_ENDPOINT` / `_PORT` / `_USE_SSL` / `_ACCESS_KEY` / `_SECRET_KEY` / `_REGION` / `_SESSION_TOKEN` | — | S3-compatible client (shared with file-server). Point at real S3 in prod. |

---

## Operating modes

`CODEAPI_RUNTIME_SESSION_MODE` picks the tradeoff:

- **`stateless`** — no registry. One VM per execution: run → execute →
  terminate. MicroVM isolation per call, but no warm sessions and no
  checkpoints. Correct and simple; the safest first AWS step.
- **`affinity`** — find-or-launch one warm VM per `runtime_session_id`. If the
  session lock is contended past `LOCK_WAIT_MS`, fall back to a correct
  stateless one-shot (warmth is only an optimization; the payload still carries
  file refs). This is the recommended default for stateful sessions.
- **`strict`** — same, but lock contention returns HTTP 409 instead of falling
  back. Use when you require a single serialized session and would rather fail
  than run cold.

---

## Alternative AWS methods

You do not have to adopt the whole stack at once. The knobs compose:

**No AWS at all.** Leave `CODEAPI_SANDBOX_BACKEND` unset (`http`). Today's
behavior, no MicroVMs, no changes needed anywhere.

**MicroVM isolation without sessions.** `lambda-microvm` + `stateless`. Every
execution gets a fresh, strongly-isolated Firecracker VM. No registry, no
checkpoints, no session workspace. Simplest way to get the isolation boundary.

**Base container image.** The default runner uses a stock `oven/bun` base and is
**hookless** — session mode arrives per request via the `X-Runtime-Session-Id`
header, so no lifecycle hooks are needed and image builds are reliable. If you
later need build/runtime lifecycle hooks (e.g. an exact suspend-time checkpoint
flush), rebase the `lambda-microvm-runner` target on the snapshot-compatible
Lambda base container image (`public.ecr.aws/lambda/microvms:al2023-minimal`),
which bakes the hook-routing service components and a snapshot-safe OpenSSL. Only
then do hooks route. See [Runbook gotchas](#runbook-gotchas).

**Checkpoint store.** The checkpoint client is MinIO-compatible. For local dev,
point `MINIO_*` at a local MinIO. For prod, point it at real S3 (endpoint
`s3.<region>.amazonaws.com`, `MINIO_USE_SSL=true`). Prefer granting the
checkpoint policy (Terraform output `checkpoint_access_policy_arn`) to your
CodeAPI task role over minting static keys.

**Egress posture.** For dev, the Lambda-managed `INTERNET_EGRESS` connector gives
default public egress. For hardened prod, set
`CODEAPI_HARDENED_SANDBOX_MODE=true` and provide a VPC egress connector + SG
locked to your egress-gateway (startup then *requires*
`LAMBDA_MICROVM_EGRESS_CONNECTOR_ARNS`). MicroVMs default to public egress, so
this gate is deliberate.

**Throughput / quota.** `RunMicrovm` is capped account-wide (~5 TPS default), so
stateless cold throughput is ~4 exec/s fleet-wide until you request a quota
raise. Warm sessions (affinity) amortize this away for repeat calls in a
conversation. Treat a fresh account as canary-only.

---

## Programmatic Tool Calling (PTC)

- **Replay PTC works** and is the only supported PTC mode on this backend
  (startup rejects `PTC_MODE=blocking`). Replay externalizes continuation state
  in Redis, so each round is an independent `/exec` that can land on a fresh
  one-shot VM and stay correct.
- **Blocking PTC is rejected** — it needs a live tool-call socket held open
  through the auth proxy mid-execution, which fights the short VM lifecycle.
- **PTC does not yet get warm sessions.** `/exec/programmatic` doesn't derive a
  `runtime_session_id`, so PTC rounds always take the stateless path even when
  the conversation's `execute_code` has a warm VM. Each replay round therefore
  costs a VM launch. Binding PTC into the session VM is a planned follow-up (the
  hint is already on the wire).

---

## Runbook gotchas

Each of these cost a silent or blind failure during bring-up:

- **Build role trust** must include `sts:TagSession` alongside `sts:AssumeRole`,
  and perms must include `logs:*` + `s3:GetObject` (+ ECR for a private base) —
  missing any yields a `CREATE_FAILED` build with an **empty** `stateReason`.
  (The Terraform module gets this right.)
- **Build logs** live at `/aws/lambda-microvms/<image-name>` (hyphen), not the
  docs' `/aws/lambda/microvms/<name>`.
- **Runtime VM stdout** needs BOTH a `cloudWatch` logging config on RunMicrovm
  AND an `executionRoleArn`, or it goes nowhere. Set
  `LAMBDA_MICROVM_EXECUTION_ROLE_ARN`.
- **nsjail inside the guest** needs `additionalOsCapabilities:["ALL"]` (for the
  `/proc` mount, else EPERM) and `SANDBOX_USE_CGROUPV2=false` (the app container
  can't read the cgroup v2 subtree). Both are baked into the image helper. Under
  ALL caps nsjail runs `no_pivotroot` — weaker in-guest isolation, acceptable
  because the MicroVM is the real trust boundary (one VM per session).
- **NOFILE**: the AL2023 guest hard-caps `RLIMIT_NOFILE` at 1024, below the
  runner's default; the entrypoint raises the hard limit to 65536. Docker masks
  this locally.
- **Hooks never route on a stock container image.** Enabling any runtime hook
  forces the `/ready` build hook, which never reaches a stock container's
  listener, so the build fails at the ready timeout. Stay hookless (the default)
  unless you rebase on the Lambda base container image.

---

## Teardown

```bash
# Terminate only VMs launched from THIS image, then delete the image.
# IMAGE_ARN scopes the sweep so it never touches unrelated MicroVMs in a shared
# account (ListMicrovms returns every VM in the region).
cd service
export IMAGE_ARN="arn:aws:lambda:us-east-1:<acct>:microvm-image:codeapi-session"
AWS_PROFILE=... bun -e 'import { LambdaMicrovmsClient, ListMicrovmsCommand, TerminateMicrovmCommand, DeleteMicrovmImageCommand } from "@aws-sdk/client-lambda-microvms"; const arn=process.env.IMAGE_ARN; const c=new LambdaMicrovmsClient({region:"us-east-1"}); const v=await c.send(new ListMicrovmsCommand({})) as any; for (const m of (v.microvms??[]).filter((x:any)=>!/TERMINAT/.test(x.state) && x.imageArn===arn)) await c.send(new TerminateMicrovmCommand({microvmIdentifier:m.microvmId})); await c.send(new DeleteMicrovmImageCommand({imageIdentifier:"codeapi-session"})).catch(()=>{});'

# then the prerequisites
cd ../docs/lambda-microvm/terraform && terraform destroy
```

MicroVM images are billed as stored snapshots; running VMs bill while RUNNING and
suspended VMs bill at a reduced rate, so terminate stray VMs before deleting the
image.
