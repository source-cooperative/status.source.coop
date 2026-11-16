# EventBridge rule that asks GitHub to run the Upptime "Uptime CI" workflow.
#
# GitHub's own `schedule:` trigger is best-effort and in practice fires every
# 30-60 minutes. A workflow_dispatch from an external scheduler runs promptly.
# See ../README.md for why this exists next to the Cloudflare scheduler.
#
# EventBridge invokes a small Lambda that mints a GitHub App installation token
# and dispatches the workflow (see lambda/ and ../shared/github.mjs).

terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }

  # Bucket, key and region are supplied at `terraform init` time by the deploy
  # workflow (-backend-config) so no account details live in the repo.
  backend "s3" {}
}

provider "aws" {
  region = var.region
}

variable "region" {
  description = "AWS region for the scheduler. Pick one that does not host the data being monitored."
  type        = string
  default     = "us-west-2"
}

variable "github_repo" {
  type    = string
  default = "source-cooperative/status.source.coop"
}

variable "github_ref" {
  type    = string
  default = "master"
}

variable "workflow_file" {
  type    = string
  default = "uptime.yml"
}

variable "schedule_expression" {
  description = "Minutes 0,5,10,... The Cloudflare scheduler uses the same ticks; the second to fire skips."
  type        = string
  default     = "cron(0/5 * * * ? *)"
}

variable "app_client_id" {
  description = "Client ID of the GitHub App that dispatches the workflow (Actions: write)."
  type        = string
}

variable "app_installation_id" {
  description = "Installation ID of that App on the repository."
  type        = string
}

variable "app_private_key" {
  description = "The App's private key, PKCS#8 PEM (openssl pkcs8 -topk8 -nocrypt)."
  type        = string
  sensitive   = true
}

locals {
  name = "source-status-scheduler"
}

resource "aws_cloudwatch_event_rule" "schedule" {
  name                = local.name
  description         = "Dispatch ${var.workflow_file} on ${var.github_repo}"
  schedule_expression = var.schedule_expression
}

# Events that could not be delivered (after retries) land here, so a broken
# token or a GitHub outage leaves evidence instead of failing silently.
resource "aws_sqs_queue" "failed" {
  name                      = "${local.name}-failed"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

# EventBridge writes undeliverable events here; the Lambda role (below) writes
# failed invocations via its own policy.
resource "aws_sqs_queue_policy" "failed" {
  queue_url = aws_sqs_queue.failed.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.failed.arn
      Condition = { ArnEquals = { "aws:SourceArn" = aws_cloudwatch_event_rule.schedule.arn } }
    }]
  })
}

resource "aws_secretsmanager_secret" "app_key" {
  name                    = "${local.name}/github-app-key"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "app_key" {
  secret_id     = aws_secretsmanager_secret.app_key.id
  secret_string = var.app_private_key
}

resource "aws_iam_role" "lambda" {
  name = local.name
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "lambda" {
  name = "run"
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = aws_secretsmanager_secret.app_key.arn
      },
      {
        Effect   = "Allow"
        Action   = "sqs:SendMessage"
        Resource = aws_sqs_queue.failed.arn
      },
    ]
  })
}

data "archive_file" "lambda" {
  type        = "zip"
  output_path = "${path.module}/lambda.zip"

  source {
    content  = file("${path.module}/lambda/index.mjs")
    filename = "index.mjs"
  }
  # Shared with the Cloudflare Worker.
  source {
    content  = file("${path.module}/../shared/github.mjs")
    filename = "github.mjs"
  }
}

resource "aws_lambda_function" "dispatch" {
  function_name    = local.name
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  timeout          = 30

  environment {
    variables = {
      KEY_SECRET_ARN         = aws_secretsmanager_secret.app_key.arn
      GH_APP_CLIENT_ID       = var.app_client_id
      GH_APP_INSTALLATION_ID = var.app_installation_id
      GITHUB_REPO            = var.github_repo
      GITHUB_REF             = var.github_ref
      WORKFLOW_FILE          = var.workflow_file
    }
  }

  # The secret value must exist before the first invocation.
  depends_on = [aws_secretsmanager_secret_version.app_key, aws_iam_role_policy.lambda]
}

# A dispatch that still fails after Lambda's retries (bad key, GitHub outage)
# lands in the failed queue, so it leaves evidence instead of failing silently.
resource "aws_lambda_function_event_invoke_config" "dispatch" {
  function_name          = aws_lambda_function.dispatch.function_name
  maximum_retry_attempts = 2

  destination_config {
    on_failure {
      destination = aws_sqs_queue.failed.arn
    }
  }

  depends_on = [aws_iam_role_policy.lambda]
}

resource "aws_lambda_permission" "events" {
  statement_id  = "AllowEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.dispatch.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.schedule.arn
}

resource "aws_cloudwatch_event_target" "dispatch" {
  rule = aws_cloudwatch_event_rule.schedule.name
  arn  = aws_lambda_function.dispatch.arn

  retry_policy {
    maximum_retry_attempts       = 2
    maximum_event_age_in_seconds = 300
  }

  dead_letter_config {
    arn = aws_sqs_queue.failed.arn
  }

  depends_on = [aws_lambda_permission.events]
}

output "rule_name" {
  value = aws_cloudwatch_event_rule.schedule.name
}

output "failed_events_queue_url" {
  description = "Messages here mean a scheduled dispatch could not be delivered."
  value       = aws_sqs_queue.failed.url
}
