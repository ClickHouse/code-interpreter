data "aws_caller_identity" "current" {}

locals {
  account_id      = data.aws_caller_identity.current.account_id
  artifact_bucket = var.create_artifact_bucket ? aws_s3_bucket.artifact[0].id : var.artifact_bucket_name

  base_tags = merge(var.tags, {
    "app"       = "codeapi"
    "component" = "lambda-microvm"
  })
}

# --------------------------------------------------------------------------
# S3: code-artifact bucket (the zip that create-microvm-image reads)
# --------------------------------------------------------------------------
resource "aws_s3_bucket" "artifact" {
  count         = var.create_artifact_bucket ? 1 : 0
  bucket        = "${var.name_prefix}-artifacts-${local.account_id}"
  force_destroy = true
  tags          = local.base_tags
}

resource "aws_s3_bucket_public_access_block" "artifact" {
  count                   = var.create_artifact_bucket ? 1 : 0
  bucket                  = aws_s3_bucket.artifact[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifact" {
  count  = var.create_artifact_bucket ? 1 : 0
  bucket = aws_s3_bucket.artifact[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

# --------------------------------------------------------------------------
# S3: session-workspace checkpoint bucket
# The CodeAPI control plane (not the MicroVM) reads/writes these. Encrypted,
# versioned for forensic history, and lifecycle-expired since checkpoints are a
# resumable cache rather than a system of record.
# --------------------------------------------------------------------------
resource "aws_s3_bucket" "checkpoint" {
  bucket        = "${var.name_prefix}-checkpoints-${local.account_id}"
  force_destroy = true
  tags          = local.base_tags
}

resource "aws_s3_bucket_public_access_block" "checkpoint" {
  bucket                  = aws_s3_bucket.checkpoint.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "checkpoint" {
  bucket = aws_s3_bucket.checkpoint.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "checkpoint" {
  bucket = aws_s3_bucket.checkpoint.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "checkpoint" {
  bucket = aws_s3_bucket.checkpoint.id
  rule {
    id     = "expire-checkpoints"
    status = "Enabled"
    filter {}
    expiration {
      days = var.checkpoint_retention_days
    }
    noncurrent_version_expiration {
      noncurrent_days = var.checkpoint_retention_days
    }
  }
}

# --------------------------------------------------------------------------
# CloudWatch Logs
# Build logs land at the EXACT path `/aws/lambda-microvms/<image-name>` (hyphen,
# not the docs' `/aws/lambda/microvms/...`). Pre-creating it sets retention;
# Lambda also auto-creates it if absent. Runtime VM stdout needs BOTH a
# cloudWatch logging config on RunMicrovm AND an execution role, or it goes
# nowhere.
# --------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "build" {
  name              = "/aws/lambda-microvms/${var.image_name}"
  retention_in_days = var.log_retention_days
  tags              = local.base_tags
}

resource "aws_cloudwatch_log_group" "runtime" {
  name              = "/${var.name_prefix}/runtime"
  retention_in_days = var.log_retention_days
  tags              = local.base_tags
}

# --------------------------------------------------------------------------
# IAM: build role (assumed by Lambda during create/update-microvm-image)
# Trust MUST include sts:TagSession, and perms MUST include logs:* + s3:GetObject
# or the build FAILS with an empty stateReason (undebuggable).
# --------------------------------------------------------------------------
data "aws_iam_policy_document" "build_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "build" {
  name               = "${var.name_prefix}-build"
  assume_role_policy = data.aws_iam_policy_document.build_trust.json
  tags               = local.base_tags
}

data "aws_iam_policy_document" "build_perms" {
  statement {
    sid       = "ArtifactRead"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["arn:aws:s3:::${local.artifact_bucket}/*"]
  }

  statement {
    sid       = "BuildLogs"
    effect    = "Allow"
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:aws:logs:${var.region}:${local.account_id}:log-group:/aws/lambda-microvms/*"]
  }

  dynamic "statement" {
    for_each = var.private_ecr ? [1] : []
    content {
      sid    = "PrivateEcrPull"
      effect = "Allow"
      actions = [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
      ]
      resources = ["*"]
    }
  }
}

resource "aws_iam_role_policy" "build" {
  name   = "build"
  role   = aws_iam_role.build.id
  policy = data.aws_iam_policy_document.build_perms.json
}

# --------------------------------------------------------------------------
# IAM: execution role (RunMicrovm executionRoleArn) — logging-only.
# The MicroVM never needs S3/network creds: checkpoints flow through the control
# plane over the authed proxy, so keep this role least-privilege.
# --------------------------------------------------------------------------
data "aws_iam_policy_document" "exec_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name_prefix}-exec"
  assume_role_policy = data.aws_iam_policy_document.exec_trust.json
  tags               = local.base_tags
}

data "aws_iam_policy_document" "exec_perms" {
  statement {
    sid       = "RuntimeLogs"
    effect    = "Allow"
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.runtime.arn}:*"]
  }
}

resource "aws_iam_role_policy" "execution" {
  name   = "runtime-logs"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.exec_perms.json
}

# --------------------------------------------------------------------------
# IAM policy document for the CodeAPI control plane's checkpoint access.
# Attach to your CodeAPI task role (preferred) or the optional user below.
# --------------------------------------------------------------------------
data "aws_iam_policy_document" "checkpoint_access" {
  statement {
    sid       = "CheckpointObjects"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.checkpoint.arn}/*"]
  }
  statement {
    sid       = "CheckpointList"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.checkpoint.arn]
  }
}

resource "aws_iam_policy" "checkpoint_access" {
  name   = "${var.name_prefix}-checkpoint-access"
  policy = data.aws_iam_policy_document.checkpoint_access.json
  tags   = local.base_tags
}

resource "aws_iam_user" "checkpoint" {
  count = var.create_checkpoint_access_user ? 1 : 0
  name  = "${var.name_prefix}-checkpoint"
  tags  = local.base_tags
}

resource "aws_iam_user_policy_attachment" "checkpoint" {
  count      = var.create_checkpoint_access_user ? 1 : 0
  user       = aws_iam_user.checkpoint[0].name
  policy_arn = aws_iam_policy.checkpoint_access.arn
}

resource "aws_iam_access_key" "checkpoint" {
  count = var.create_checkpoint_access_user ? 1 : 0
  user  = aws_iam_user.checkpoint[0].name
}
