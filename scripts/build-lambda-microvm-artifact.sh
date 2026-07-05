#!/bin/bash
# Builds the AWS Lambda MicroVM sandbox-runner artifacts.
#
# The Lambda MicroVM image pipeline is: zip(Dockerfile) -> S3 ->
# CreateMicrovmImage builds it on the AL2023 MicroVM base image. Our
# Dockerfile is a single FROM pointing at the prebuilt arm64 runner image
# in a same-account ECR repo (Lambda's build infra can pull it there).
#
# Stages (each optional, in order):
#   build   docker buildx the arm64 lambda-microvm-runner target (no AWS)
#   push    push to ECR (needs AWS_PROFILE + repo)
#   zip     render the code-artifact Dockerfile and zip it (no AWS)
#   upload  upload the zip to S3 (needs AWS_PROFILE + bucket)
#
# Usage:
#   scripts/build-lambda-microvm-artifact.sh build
#   scripts/build-lambda-microvm-artifact.sh build push zip upload
#
# Env:
#   ECR_URI        e.g. 951834775723.dkr.ecr.us-east-2.amazonaws.com/codeapi-microvm-runner
#   IMAGE_TAG      default: git short sha
#   S3_URI         e.g. s3://codeapi-microvm-artifacts/runner
#   AWS_PROFILE    e.g. librechat-dev
#   AWS_REGION     required for push/upload
set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD)}"
ECR_URI="${ECR_URI:-}"
S3_URI="${S3_URI:-}"
OUT_DIR="${OUT_DIR:-.build-lambda-microvm}"
LOCAL_TAG="codeapi-lambda-microvm-runner:${IMAGE_TAG}"

require_ecr() {
  [ -n "$ECR_URI" ] || { echo "ECR_URI is required for this stage" >&2; exit 1; }
}

do_build() {
  echo ">> buildx arm64 lambda-microvm-runner (${LOCAL_TAG})"
  docker buildx build \
    --platform linux/arm64 \
    --target lambda-microvm-runner \
    -f api/Dockerfile \
    -t "$LOCAL_TAG" \
    ${ECR_URI:+-t "$ECR_URI:$IMAGE_TAG"} \
    --load \
    .
}

do_push() {
  require_ecr
  echo ">> pushing $ECR_URI:$IMAGE_TAG"
  aws ecr get-login-password --region "${AWS_REGION:?AWS_REGION required}" \
    | docker login --username AWS --password-stdin "${ECR_URI%%/*}"
  docker push "$ECR_URI:$IMAGE_TAG"
}

do_zip() {
  require_ecr
  mkdir -p "$OUT_DIR"
  cat > "$OUT_DIR/Dockerfile" <<EOF
FROM ${ECR_URI}:${IMAGE_TAG}
EOF
  (cd "$OUT_DIR" && rm -f artifact.zip && zip -q artifact.zip Dockerfile)
  echo ">> wrote $OUT_DIR/artifact.zip (FROM ${ECR_URI}:${IMAGE_TAG})"
}

do_upload() {
  [ -n "$S3_URI" ] || { echo "S3_URI is required for upload" >&2; exit 1; }
  local key="$S3_URI/runner-${IMAGE_TAG}.zip"
  aws s3 cp "$OUT_DIR/artifact.zip" "$key" --region "${AWS_REGION:?AWS_REGION required}"
  echo ">> uploaded $key"
  cat <<EOF

Next (spike item 2):
  aws lambda-microvms create-microvm-image \\
    --name codeapi-sandbox \\
    --code-artifact "uri=$key" \\
    --base-image-arn arn:aws:lambda:\${AWS_REGION}:aws:microvm-image:al2023-1 \\
    --build-role-arn <build-role-with-s3+ecr-read> \\
    --hook-port 8080 \\
    --region \${AWS_REGION}

Notes:
- env vars (SANDBOX_EXECUTION_MANIFEST_PUBLIC_KEY, SANDBOX_REQUIRE_EGRESS_MANIFEST,
  EGRESS_GATEWAY_URL, SANDBOX_ALLOWED_LOCAL_NETWORK_PORT) are image-build-time
  config: pass them via --environment-variables on create/update-microvm-image.
- /ready + /run/resume/suspend/terminate hooks are served on port 8080 at
  /aws/lambda-microvms/runtime/v1/*.
EOF
}

for stage in "$@"; do
  case "$stage" in
    build) do_build ;;
    push) do_push ;;
    zip) do_zip ;;
    upload) do_upload ;;
    *) echo "Unknown stage: $stage (expected build|push|zip|upload)" >&2; exit 1 ;;
  esac
done

[ $# -gt 0 ] || { echo "No stages given. Usage: $0 build [push] [zip] [upload]" >&2; exit 1; }
