# Code Interpreter API Helm Chart

Deploy the horizontally-scalable Code Interpreter API stack to Kubernetes.

## Prerequisites

- Docker Desktop with Kubernetes enabled, OR
- Minikube installed (`brew install minikube` / `choco install minikube`)
- Helm 3.x (`brew install helm` / `choco install kubernetes-helm`)
- kubectl (`brew install kubectl` / `choco install kubernetes-cli`)

## Quick Start (Local Development)

### 1. Start Minikube
```bash
minikube start --cpus=4 --memory=8192
```

### 2. Build Images Inside Minikube
```bash
# Point docker to minikube's daemon
eval $(minikube docker-env)

# Build all images
cd services/codeapi
docker build -t codeapi-api:latest -f service/Dockerfile.api service/
docker build -t codeapi-worker:latest -f service/Dockerfile.worker service/
docker build -t codeapi-sandbox-runner:latest -f api/Dockerfile .
docker build -t codeapi-file-server:latest -f service/Dockerfile --target production service/
docker build -t codeapi-tool-call-server:latest -f service/Dockerfile.tool-call-server --target production service/
docker build -t codeapi-package-init:latest -f docker/Dockerfile.package-init .
```

### 3. Install Dependencies & Deploy
```bash
cd services/codeapi/helm/codeapi

# Download chart dependencies (Redis)
helm dependency update

# Deploy! Override internalServiceAuth.token for any shared/prod cluster.
helm install codeapi . -f values-local.yaml
```

### 4. Language Packages (Automatic)

The chart includes a **package-init Job** that runs as a Helm `pre-install` hook. It automatically compiles Python, downloads Node/Bun, installs offline package sets, and registers Bash into the packages PVC before the worker pods start.

This happens automatically on `helm install`. To force a rebuild:

```bash
helm upgrade codeapi . --set workerSandbox.packages.initJob.forceRebuild=true
```

To check init job status:

```bash
kubectl get jobs -l app.kubernetes.io/component=package-init
kubectl logs job/codeapi-package-init
```

When deploying the `/pkgs` package-root migration, update sandbox env values to
`SANDBOX_PACKAGES_DIRECTORY=/pkgs` and force a package rebuild on the first rollout
so generated Python/Node/Bun paths are recreated under `/pkgs`:

```bash
helm upgrade codeapi . --set workerSandbox.packages.initJob.forceRebuild=true
```

To manually populate packages instead (e.g., from a pre-built directory):

```bash
kubectl run pvc-populator --image=alpine --command -- sleep 3600 \
  --overrides='{"spec":{"containers":[{"name":"pvc-populator","image":"alpine","command":["sleep","3600"],"volumeMounts":[{"name":"packages","mountPath":"/packages"}]}],"volumes":[{"name":"packages","persistentVolumeClaim":{"claimName":"codeapi-packages"}}]}}'

kubectl wait --for=condition=ready pod/pvc-populator --timeout=60s
kubectl cp ./data/pkgs/. pvc-populator:/packages/
kubectl delete pod pvc-populator
kubectl rollout restart deployment/codeapi-sandbox-runner
```

### 5. Access the API
```bash
# Port forward (in another terminal)
kubectl port-forward svc/codeapi-api 3112:3112

# Test
curl http://localhost:3112/v1/health
```

---

## Commands Reference

### Startup
```bash
# Start minikube
minikube start

# Deploy (package-init job runs automatically)
helm install codeapi ./helm/codeapi -f ./helm/codeapi/values-local.yaml

# Port forward
kubectl port-forward svc/codeapi-api 3112:3112
```

### Check Status
```bash
# View all pods
kubectl get pods

# View logs
kubectl logs deployment/codeapi-api
kubectl logs deployment/codeapi-service-worker
kubectl logs deployment/codeapi-sandbox-runner

# Describe pod (for debugging)
kubectl describe pod <pod-name>
```

### Scaling
```bash
# Scale the sandbox execution tier
kubectl scale deployment/codeapi-sandbox-runner --replicas=10

# Or via Helm upgrade
helm upgrade codeapi ./helm/codeapi -f ./helm/codeapi/values-local.yaml \
  --set workerSandbox.sandboxRunner.replicaCount=10
```

### Update After Code Changes
```bash
# Rebuild images (must be in minikube docker env)
eval $(minikube docker-env)
docker build -t codeapi-worker:latest -f service/Dockerfile.worker service/
docker build -t codeapi-sandbox-runner:latest -f api/Dockerfile .

# Restart deployments to pick up new images
kubectl rollout restart deployment/codeapi-service-worker
kubectl rollout restart deployment/codeapi-sandbox-runner
```

### Teardown
```bash
# Uninstall the Helm release (removes all K8s resources)
helm uninstall codeapi

# Stop minikube (preserves state for next time)
minikube stop

# OR: Delete minikube entirely (full reset)
minikube delete
```

---

## Testing

### Health Check
```bash
curl http://localhost:3112/v1/health
# Expected: OK
```

### Execute Python Code
```bash
curl -X POST http://localhost:3112/v1/exec \
  -H "Content-Type: application/json" \
  -H "X-API-Key: test-key" \
  -d '{"lang": "py", "code": "print(\"Hello from K8s!\")"}'
```

### Verify Horizontal Scaling
```bash
# Check which service-worker processed the job
kubectl logs deployment/codeapi-service-worker --tail=5

# Each pod has a unique ID - jobs are distributed across all workers
```

---

## Architecture

```
+---------------------------------------------------------------------+
|                         Kubernetes Cluster                           |
|                                                                      |
|  +--------------+                                                    |
|  |  API Pod     |  <-- Scale independently for HTTP traffic          |
|  |  (HTTP)      |                                                    |
|  +------+-------+                                                    |
|         |                                                            |
|         v                                                            |
|   +-----------+                                                      |
|   |   Redis   |  <-- Global shared job queue                         |
|   |  (queue)  |                                                      |
|   +-----+-----+                                                      |
|         |                                                            |
|         +----------------+----------------+                          |
|         v                v                v                          |
|  +--------------+  +--------------+  +--------------+                |
|  | Worker-      |  | Worker-      |  | Worker-      |  <-- Scale by  |
|  | Sandbox 1    |  | Sandbox 2    |  | Sandbox 3    |     queue depth |
|  | +----------+ |  | +----------+ |  | +----------+ |                |
|  | | Worker   | |  | | Worker   | |  | | Worker   | |                |
|  | | (conc:1) | |  | | (conc:1) | |  | | (conc:1) | |                |
|  | +----+-----+ |  | +----+-----+ |  | +----+-----+ |                |
|  |      |        |  |      |        |  |      |        |                |
|  | +----v-----+ |  | +----v-----+ |  | +----v-----+ |                |
|  | | Sandbox  | |  | | Sandbox  | |  | | Sandbox  | |                |
|  | | (NsJail) | |  | | (NsJail) | |  | | (NsJail) | |                |
|  | +----------+ |  | +----------+ |  | +----------+ |                |
|  +--------------+  +--------------+  +--------------+                |
|                                                                      |
|  +---------------------------------------------------------------+   |
|  |              PersistentVolume (Packages)                       |   |
|  |  /pkgs - Python, Node, Bun runtimes                            |   |
|  |  ReadOnlyMany - shared across all sandbox-runner pods          |   |
|  +---------------------------------------------------------------+   |
|                                                                      |
|  Total sandbox capacity: 3 pods x 8 concurrent jobs = 24 jobs        |
+----------------------------------------------------------------------+
```

---

## Troubleshooting

### Pod stuck in `ErrImageNeverPull`
```bash
# Images must be built inside minikube's docker
eval $(minikube docker-env)
docker build -t <image-name>:latest ...
kubectl rollout restart deployment/<deployment-name>
```

### Pod stuck in `CrashLoopBackOff`
```bash
# Check logs
kubectl logs <pod-name> --previous
kubectl describe pod <pod-name>
```

### "runtime is unknown" error
```bash
# Language packages PVC is empty. Check if the init job ran:
kubectl get jobs -l app.kubernetes.io/component=package-init
kubectl logs job/codeapi-package-init

# Force a rebuild:
helm upgrade codeapi . --set workerSandbox.packages.initJob.forceRebuild=true

# Then restart sandbox-runner pods
kubectl rollout restart deployment/codeapi-sandbox-runner
```

### Connection refused on port 3112
```bash
# Make sure port-forward is running
kubectl port-forward svc/codeapi-api 3112:3112
```

### MinIO `ImagePullBackOff` (production values)
```bash
# The Bitnami MinIO chart may reference unavailable image tags.
# For local dev, values-local.yaml uses minio.useSimple=true which
# deploys the official minio/minio:latest image instead.
#
# If you see this in production, either:
# 1. Use minio.useSimple=true
# 2. Or specify a valid Bitnami image tag in values.yaml
```

---

## Migration from v0.1.0 (Piston) to v0.2.0 (NsJail)

Chart v0.2.0 replaces the Piston/isolate sandbox engine with NsJail. This is a breaking change for env var names but backward compatible for everything else.

### What changed

| Area | v0.1.0 (Piston) | v0.2.0 (NsJail) |
|------|-----------------|------------------|
| Sandbox engine | Piston isolate | Google NsJail |
| Env var prefix | `PISTON_*` | `SANDBOX_*` |
| Entrypoint | `docker-entrypoint-production.sh` | `entrypoint.sh` |
| Working directory | `/home` | `/mnt/data` |
| Security model | isolate + chroot | namespaces + cgroups + seccomp-bpf |
| Privileged mode | Required (unchanged) | Required (unchanged) |
| Package format | Piston packages | Runtime package directories |
| API contract | `/api/v2/execute` | `/api/v2/execute` (unchanged) |

### Upgrade steps

1. Rebuild the `codeapi-sandbox-runner` Docker image with the new Dockerfile
2. Run `helm upgrade codeapi ./helm/codeapi -f values.yaml` -- the template now emits `SANDBOX_*` env vars automatically
3. No changes to language packages, Redis, MinIO, or the service layer are required

### Env var mapping

If you had custom overrides via `extraEnv`, rename them:

- `PISTON_LOG_LEVEL` -> `SANDBOX_LOG_LEVEL`
- `PISTON_MAX_PROCESS_COUNT` -> `SANDBOX_MAX_PROCESS_COUNT`
- `PISTON_RUN_CPU_TIME` -> `SANDBOX_RUN_CPU_TIME`
- `PISTON_RUN_TIMEOUT` -> `SANDBOX_RUN_TIMEOUT`
- `PISTON_OUTPUT_MAX_SIZE` -> `SANDBOX_OUTPUT_MAX_SIZE`
- `PISTON_DISABLE_NETWORKING` -> `SANDBOX_DISABLE_NETWORKING`

---

## AWS / Cloud Deployment

For production AWS deployment, see the section below.
