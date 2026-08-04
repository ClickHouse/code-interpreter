#!/usr/bin/env bash
set -euo pipefail

# Regression coverage for issue #15: KVM deployment defaults must boot the
# baked package tree from a block root and must not reintroduce /host-packages
# as a long-lived virtio-fs mount.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

for command in docker helm jq; do
    if ! command -v "$command" >/dev/null 2>&1; then
        echo "missing required command: $command" >&2
        exit 1
    fi
done

assert_contains() {
    local file="$1"
    local pattern="$2"
    local message="$3"
    if ! grep -Eq "$pattern" "$file"; then
        echo "$message" >&2
        exit 1
    fi
}

assert_not_contains() {
    local file="$1"
    local pattern="$2"
    local message="$3"
    if grep -Eq "$pattern" "$file"; then
        echo "$message" >&2
        exit 1
    fi
}

assert_env_value() {
    local file="$1"
    local name="$2"
    local expected="$3"
    local message="$4"
    if ! awk -v name="$name" -v expected="$expected" '
        $0 ~ "- name: " name {
            getline
            if ($0 ~ "value: \\\"" expected "\\\"") found = 1
        }
        END { exit found ? 0 : 1 }
    ' "$file"; then
        echo "$message" >&2
        exit 1
    fi
}

assert_compose_mode() {
    local compose_file="$1"
    local service="$2"
    local kvm_enabled="$3"
    local expected_target="$4"
    local output="$5"

    KVM_ENABLED="$kvm_enabled" \
        docker compose -f "$compose_file" config --format json > "$output"

    local target
    target="$(jq -r --arg service "$service" '.services[$service].build.target // ""' "$output")"
    if [[ "$target" != "$expected_target" ]]; then
        echo "$compose_file: $service target is '$target', expected '$expected_target'" >&2
        exit 1
    fi

    if ! jq -e --arg service "$service" --arg expected "$kvm_enabled" \
        '.services[$service].environment.KVM_ENABLED == $expected' \
        "$output" >/dev/null; then
        echo "$compose_file: $service did not preserve KVM_ENABLED=$kvm_enabled" >&2
        exit 1
    fi

    if [[ "$kvm_enabled" == "true" ]]; then
        local packages_host
        packages_host="$(jq -r --arg service "$service" \
            '.services[$service].environment.LAUNCHER_PACKAGES_HOST // ""' "$output")"
        if [[ "$packages_host" != "/disabled-host-packages" ]]; then
            echo "$compose_file: KVM mode could expose /host-packages to libkrun" >&2
            exit 1
        fi
    elif ! jq -e --arg service "$service" \
        'any((.services[$service].volumes // [])[]; .target == "/host-packages")' \
        "$output" >/dev/null; then
        echo "$compose_file: direct mode lost its /host-packages compatibility mount" >&2
        exit 1
    fi
}

assert_compose_mode \
    "$ROOT/docker-compose.yaml" \
    sandbox-runner \
    true \
    sandbox-runner-true \
    "$TMP_DIR/compose.json"
assert_compose_mode \
    "$ROOT/docker-compose.local-dev.yml" \
    sandbox \
    true \
    sandbox-runner-true \
    "$TMP_DIR/compose-local.json"
assert_compose_mode \
    "$ROOT/docker-compose.scalable.yml" \
    worker-sandbox \
    true \
    worker-sandbox-true \
    "$TMP_DIR/compose-scalable.json"

assert_compose_mode \
    "$ROOT/docker-compose.yaml" \
    sandbox-runner \
    false \
    sandbox-runner-false \
    "$TMP_DIR/compose-direct.json"
assert_compose_mode \
    "$ROOT/docker-compose.local-dev.yml" \
    sandbox \
    false \
    sandbox-runner-false \
    "$TMP_DIR/compose-local-direct.json"
assert_compose_mode \
    "$ROOT/docker-compose.scalable.yml" \
    worker-sandbox \
    false \
    worker-sandbox-false \
    "$TMP_DIR/compose-scalable-direct.json"

if [[ "$(awk '/^FROM / { stage=$NF } END { print stage }' "$ROOT/api/Dockerfile")" != "sandbox-runner-default" ]]; then
    echo "api/Dockerfile must default to the baked block-root runner" >&2
    exit 1
fi
if [[ "$(awk '/^FROM / { stage=$NF } END { print stage }' "$ROOT/docker/Dockerfile.worker-sandbox")" != "worker-sandbox-default" ]]; then
    echo "docker/Dockerfile.worker-sandbox must default to the baked block-root runner" >&2
    exit 1
fi

assert_contains \
    "$ROOT/api/Dockerfile" \
    '^FROM sandbox-runner-baked AS sandbox-runner-true$' \
    "sandbox-runner-true must inherit the baked target"
assert_contains \
    "$ROOT/api/Dockerfile" \
    '^FROM sandbox-runner AS sandbox-runner-false$' \
    "sandbox-runner-false must inherit the direct/PVC target"
assert_contains \
    "$ROOT/docker/Dockerfile.worker-sandbox" \
    '^FROM worker-sandbox-baked AS worker-sandbox-true$' \
    "worker-sandbox-true must inherit the baked target"
assert_contains \
    "$ROOT/docker/Dockerfile.worker-sandbox" \
    '^FROM worker-sandbox-legacy AS worker-sandbox-false$' \
    "worker-sandbox-false must inherit the direct target"
assert_contains \
    "$ROOT/docker/Dockerfile.worker-sandbox" \
    'sandbox-runner-healthcheck.sh' \
    "the combined worker image must check guest clock skew"

awk '
    /^FROM / {
        if (inside) exit
        inside = ($NF == "sandbox-runner-baked")
    }
    inside { print }
' "$ROOT/api/Dockerfile" > "$TMP_DIR/api-baked-stage"
awk '
    /^FROM / {
        if (inside) exit
        inside = ($NF == "worker-sandbox-baked")
    }
    inside { print }
' "$ROOT/docker/Dockerfile.worker-sandbox" > "$TMP_DIR/worker-baked-stage"

for baked_stage in "$TMP_DIR/api-baked-stage" "$TMP_DIR/worker-baked-stage"; do
    assert_contains \
        "$baked_stage" \
        '^ENV LAUNCHER_ROOT_DISK=/sandbox-rootfs.img' \
        "$baked_stage must configure the block root"
    assert_not_contains \
        "$baked_stage" \
        '/host-packages' \
        "$baked_stage must not create the package virtio-fs path"
done

# The chart dependencies are unrelated to package delivery. Copy the chart to
# a temporary directory without its dependency block so this test remains
# hermetic and does not download Redis or MinIO.
mkdir "$TMP_DIR/chart"
cp "$ROOT/helm/codeapi/values.yaml" "$TMP_DIR/chart/values.yaml"
cp -R "$ROOT/helm/codeapi/templates" "$TMP_DIR/chart/templates"
awk '/^dependencies:/{exit} {print}' \
    "$ROOT/helm/codeapi/Chart.yaml" > "$TMP_DIR/chart/Chart.yaml"

helm template codeapi "$TMP_DIR/chart" \
    --set executionManifest.privateKey=test \
    --set executionManifest.publicKey=test \
    > "$TMP_DIR/helm-image.yaml"

assert_contains \
    "$TMP_DIR/helm-image.yaml" \
    'image: "codeapi-sandbox-runner:latest"' \
    "default Helm render must preserve sandboxImage"
assert_not_contains \
    "$TMP_DIR/helm-image.yaml" \
    'mountPath: /host-packages' \
    "default Helm render must not mount /host-packages"
assert_not_contains \
    "$TMP_DIR/helm-image.yaml" \
    '^kind: PersistentVolumeClaim$' \
    "default Helm render must not create the packages PVC"
assert_not_contains \
    "$TMP_DIR/helm-image.yaml" \
    'app.kubernetes.io/component: package-init' \
    "default Helm render must not create package-init"
assert_env_value \
    "$TMP_DIR/helm-image.yaml" \
    SANDBOX_RUNNER_CLOCK_SKEW_LIVENESS_LIMIT_SECONDS \
    10 \
    "default Helm render must keep clock skew below the manifest tolerance"
assert_env_value \
    "$TMP_DIR/helm-image.yaml" \
    SANDBOX_RUNNER_CLOCK_SKEW_LIVENESS_JITTER_SECONDS \
    2 \
    "default Helm render must stagger clock-skew recycling across replicas"

helm template codeapi "$TMP_DIR/chart" \
    --set executionManifest.privateKey=test \
    --set executionManifest.publicKey=test \
    --set workerSandbox.sandboxImage.repository=registry.example/sandbox \
    --set workerSandbox.sandboxImage.tag=custom \
    > "$TMP_DIR/helm-custom-image.yaml"

assert_contains \
    "$TMP_DIR/helm-custom-image.yaml" \
    'image: "registry.example/sandbox:custom"' \
    "image package mode must preserve the established sandboxImage override"

helm template codeapi "$TMP_DIR/chart" \
    --set executionManifest.privateKey=test \
    --set executionManifest.publicKey=test \
    --set workerSandbox.packages.source=pvc \
    > "$TMP_DIR/helm-pvc.yaml"

assert_contains \
    "$TMP_DIR/helm-pvc.yaml" \
    'image: "codeapi-sandbox-runner:latest"' \
    "PVC compatibility mode must select sandboxImage"
assert_contains \
    "$TMP_DIR/helm-pvc.yaml" \
    'mountPath: /host-packages' \
    "PVC compatibility mode must mount /host-packages"
assert_contains \
    "$TMP_DIR/helm-pvc.yaml" \
    '^kind: PersistentVolumeClaim$' \
    "PVC compatibility mode must create the packages PVC"
assert_contains \
    "$TMP_DIR/helm-pvc.yaml" \
    'app.kubernetes.io/component: package-init' \
    "PVC compatibility mode must create package-init"

helm template codeapi "$TMP_DIR/chart" \
    --set executionManifest.privateKey=test \
    --set executionManifest.publicKey=test \
    --set workerSandbox.sandboxRunner.fdLivenessLimit=0 \
    > "$TMP_DIR/helm-no-fd-liveness.yaml"

assert_contains \
    "$TMP_DIR/helm-no-fd-liveness.yaml" \
    'value: "0"' \
    "fdLivenessLimit=0 must reach the healthcheck instead of reverting to 40000"

helm template codeapi "$TMP_DIR/chart" \
    --set executionManifest.privateKey=test \
    --set executionManifest.publicKey=test \
    --set workerSandbox.sandboxRunner.clockSkewLivenessLimitSeconds=0 \
    > "$TMP_DIR/helm-no-clock-skew-liveness.yaml"

assert_env_value \
    "$TMP_DIR/helm-no-clock-skew-liveness.yaml" \
    SANDBOX_RUNNER_CLOCK_SKEW_LIVENESS_LIMIT_SECONDS \
    0 \
    "clockSkewLivenessLimitSeconds=0 must reach the healthcheck instead of reverting to 10"

if helm template codeapi "$TMP_DIR/chart" \
    --set executionManifest.privateKey=test \
    --set executionManifest.publicKey=test \
    --set workerSandbox.sandboxRunner.clockSkewLivenessLimitSeconds=30 \
    > "$TMP_DIR/invalid-clock-skew-limit.yaml" 2> "$TMP_DIR/invalid-clock-skew-limit.log"; then
    echo "clock-skew liveness limit must stay below manifest tolerance" >&2
    exit 1
fi

assert_contains \
    "$TMP_DIR/invalid-clock-skew-limit.log" \
    'clockSkewLivenessLimitSeconds must be between 0 and 29' \
    "clock-skew limit validation failed for an unexpected reason"

if helm template codeapi "$TMP_DIR/chart" \
    --set executionManifest.privateKey=test \
    --set executionManifest.publicKey=test \
    --set workerSandbox.sandboxRunner.clockSkewLivenessJitterSeconds=10 \
    > "$TMP_DIR/invalid-clock-skew-jitter.yaml" 2> "$TMP_DIR/invalid-clock-skew-jitter.log"; then
    echo "clock-skew liveness jitter must stay below the configured limit" >&2
    exit 1
fi

assert_contains \
    "$TMP_DIR/invalid-clock-skew-jitter.log" \
    'clockSkewLivenessJitterSeconds must be non-negative and less than clockSkewLivenessLimitSeconds' \
    "clock-skew jitter validation failed for an unexpected reason"

if helm template codeapi "$TMP_DIR/chart" \
    --set executionManifest.privateKey=test \
    --set executionManifest.publicKey=test \
    --set workerSandbox.kvmEnabled=false \
    > "$TMP_DIR/invalid.yaml" 2> "$TMP_DIR/invalid.log"; then
    echo "image package source must fail without KVM" >&2
    exit 1
fi

assert_contains \
    "$TMP_DIR/invalid.log" \
    'packages.source=image requires workerSandbox.kvmEnabled=true' \
    "KVM validation failed for an unexpected reason"

if helm template codeapi "$TMP_DIR/chart" \
    --set executionManifest.privateKey=test \
    --set executionManifest.publicKey=test \
    --set workerSandbox.packages.source=invalid \
    > "$TMP_DIR/invalid-source.yaml" 2> "$TMP_DIR/invalid-source.log"; then
    echo "unknown package source must fail" >&2
    exit 1
fi

assert_contains \
    "$TMP_DIR/invalid-source.log" \
    'workerSandbox.packages.source must be image or pvc' \
    "package source validation failed for an unexpected reason"

echo "block-root package delivery checks passed"
