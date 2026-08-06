output "region" {
  value = var.region
}

output "artifact_bucket" {
  description = "S3 bucket for the code-artifact zip (feed to build-lambda-microvm-artifact.sh S3_URI)."
  value       = local.artifact_bucket
}

output "runner_ecr_repository_url" {
  description = "Set as ECR_URI for scripts/build-lambda-microvm-artifact.sh. Null when private_ecr is false."
  value       = local.runner_repository_url
}

output "checkpoint_bucket" {
  description = "S3 bucket for session checkpoints (CODEAPI_CHECKPOINT_BUCKET)."
  value       = aws_s3_bucket.checkpoint.id
}

output "build_role_arn" {
  description = "Pass to create-microvm-image.ts as --build-role."
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
  description = "Attach to the CodeAPI worker/task role for checkpoint S3 access."
  value       = aws_iam_policy.checkpoint_access.arn
}

output "worker_microvm_control_policy_arn" {
  description = "Attach to the CodeAPI worker/task role for Run/Get/CreateToken/Terminate plus PassRole/PassNetworkConnector."
  value       = aws_iam_policy.worker_microvm_control.arn
}

output "microvm_image_arn" {
  description = "Expected image ARN for image_name; create-microvm-image.ts creates this resource."
  value       = local.microvm_image_arn
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
