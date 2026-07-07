# Terraform: Lambda MicroVM prerequisites

Provisions the static AWS resources the CodeAPI Lambda MicroVM backend needs. The
MicroVM image and running VMs themselves are **not** Terraform-managed — the
`lambda-microvms` service has no TF resource yet, so those are created with
[`service/scripts/create-microvm-image.ts`](../../../service/scripts/create-microvm-image.ts)
and by the backend at runtime. See [../README.md](../README.md) for the full
walkthrough.

## What it creates

- **Checkpoint S3 bucket** — encrypted (SSE-KMS), versioned, public-access
  blocked, lifecycle-expired (`checkpoint_retention_days`).
- **Artifact S3 bucket** — for the code-artifact zip (optional; reuse an existing
  one with `create_artifact_bucket = false` + `artifact_bucket_name`).
- **Build role** — assumed by Lambda during `create/update-microvm-image`. Trust
  includes `sts:TagSession`; perms include `logs:*`, `s3:GetObject` on the
  artifact bucket, and (optional) private-ECR pull. Getting this wrong yields a
  build failure with an empty `stateReason`.
- **Execution role** — logging-only least-privilege, for `RunMicrovm`.
- **CloudWatch log groups** — build (`/aws/lambda-microvms/<image_name>`) and
  runtime.
- **Checkpoint access** — an IAM policy to attach to your CodeAPI task role
  (preferred), or an optional IAM user + access key
  (`create_checkpoint_access_user = true`) for non-role deployments.

## Usage

```bash
cp terraform.tfvars.example terraform.tfvars   # edit
terraform init
terraform apply
terraform output
```

## Notes

- Set `image_name` to match the `--name` you pass to `create-microvm-image.ts`,
  so the build log group is pre-created at the exact path Lambda writes to.
- `create_checkpoint_access_user = true` exposes `checkpoint_access_key_id` and
  the sensitive `checkpoint_secret_access_key` outputs — use as `MINIO_ACCESS_KEY`
  / `MINIO_SECRET_KEY`. Prefer the task-role policy when you can.
- Buckets use `force_destroy = true` so `terraform destroy` is clean in dev.
  Reconsider for prod.
