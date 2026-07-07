output "region" {
  value = var.region
}

output "artifact_bucket" {
  description = "S3 bucket for the code-artifact zip (feed to build-lambda-microvm-artifact.sh S3_URI)."
  value       = local.artifact_bucket
}

output "checkpoint_bucket" {
  description = "S3 bucket for session checkpoints (CODEAPI_CHECKPOINT_BUCKET)."
  value       = aws_s3_bucket.checkpoint.id
}

output "build_role_arn" {
  description = "Pass to create-microvm-image as --build-role-arn."
  value       = aws_iam_role.build.arn
}

output "execution_role_arn" {
  description = "Set as LAMBDA_MICROVM_EXECUTION_ROLE_ARN so runtime VM stdout reaches CloudWatch."
  value       = aws_iam_role.execution.arn
}

output "build_log_group" {
  value = aws_cloudwatch_log_group.build.name
}

output "runtime_log_group" {
  value = aws_cloudwatch_log_group.runtime.name
}

output "checkpoint_access_policy_arn" {
  description = "Attach to your CodeAPI task role for checkpoint S3 access (preferred over the IAM user)."
  value       = aws_iam_policy.checkpoint_access.arn
}

output "checkpoint_access_key_id" {
  description = "Only when create_checkpoint_access_user = true. Use as MINIO_ACCESS_KEY."
  value       = try(aws_iam_access_key.checkpoint[0].id, null)
}

output "checkpoint_secret_access_key" {
  description = "Only when create_checkpoint_access_user = true. Use as MINIO_SECRET_KEY."
  value       = try(aws_iam_access_key.checkpoint[0].secret, null)
  sensitive   = true
}
