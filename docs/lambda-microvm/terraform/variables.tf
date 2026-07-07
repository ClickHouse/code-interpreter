variable "region" {
  description = "AWS region to provision into. Lambda MicroVMs must be available here."
  type        = string
  default     = "us-east-1"
}

variable "name_prefix" {
  description = "Prefix for all created resource names (roles, buckets, log groups)."
  type        = string
  default     = "codeapi-microvm"
}

variable "image_name" {
  description = <<-EOT
    Name of the MicroVM image you will create with the SDK/CLI helper. Only used
    to pre-create the build log group at the exact path Lambda writes to
    (`/aws/lambda-microvms/<image_name>`). Must match the `--name` you pass to
    create-microvm-image.
  EOT
  type        = string
  default     = "codeapi-session"
}

variable "create_artifact_bucket" {
  description = <<-EOT
    Create an S3 bucket to hold the code-artifact zip that
    `scripts/build-lambda-microvm-artifact.sh` uploads. Set false to reuse an
    existing bucket via `artifact_bucket_name`.
  EOT
  type        = bool
  default     = true
}

variable "artifact_bucket_name" {
  description = "Existing artifact bucket name when create_artifact_bucket = false."
  type        = string
  default     = ""

  # Reject an empty name when reusing an existing bucket, else the build-role
  # policy resolves to `arn:aws:s3:::/*` and the build can't read the artifact.
  validation {
    condition     = var.create_artifact_bucket || length(var.artifact_bucket_name) > 0
    error_message = "artifact_bucket_name must be set when create_artifact_bucket is false."
  }
}

variable "checkpoint_retention_days" {
  description = <<-EOT
    Days to keep session-workspace checkpoints in the checkpoint bucket before
    lifecycle expiration. Checkpoints are a resumable cache, not a system of
    record, so a short window is fine.
  EOT
  type        = number
  default     = 14
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for the build + runtime log groups."
  type        = number
  default     = 30
}

variable "private_ecr" {
  description = <<-EOT
    Grant the build role permission to pull the runner container image from a
    private ECR repo in this account. Required when the code-artifact Dockerfile
    uses `FROM <acct>.dkr.ecr...`. Leave false for public base images.
  EOT
  type        = bool
  default     = true
}

variable "create_checkpoint_access_user" {
  description = <<-EOT
    Create an IAM user + access key with read/write on the checkpoint bucket, for
    the CodeAPI service's MinIO-compatible checkpoint client (MINIO_ACCESS_KEY /
    MINIO_SECRET_KEY). This is currently the ONLY working path: the checkpoint
    client reads static keys and does not load task-role/IRSA credentials, so
    attaching `checkpoint_access_policy_arn` to a task role alone does not work
    yet. Set true unless you supply MINIO_ACCESS_KEY/SECRET some other way.
  EOT
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags applied to every created resource."
  type        = map(string)
  default     = {}
}
