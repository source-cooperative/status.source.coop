# EventBridge rule that asks GitHub to run the Upptime "Uptime CI" workflow.
#
# GitHub's own `schedule:` trigger is best-effort and in practice fires every
# 30-60 minutes. A workflow_dispatch from an external scheduler runs promptly.
# See ../README.md for why this exists next to the Cloudflare scheduler.
#
# No Lambda: an EventBridge API destination POSTs to the GitHub API directly.

terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
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
  description = "Minutes 0,5,10,... The Cloudflare scheduler runs at 2,7,12,... so the two interleave."
  type        = string
  default     = "cron(0/5 * * * ? *)"
}

variable "dispatch_token" {
  description = "Fine-grained PAT for this repo only, Actions: read and write."
  type        = string
  sensitive   = true
}

locals {
  name = "source-status-scheduler"
}

resource "aws_cloudwatch_event_connection" "github" {
  name               = local.name
  authorization_type = "API_KEY"

  auth_parameters {
    api_key {
      key   = "Authorization"
      value = "Bearer ${var.dispatch_token}"
    }
  }
}

resource "aws_cloudwatch_event_api_destination" "dispatch" {
  name                             = local.name
  connection_arn                   = aws_cloudwatch_event_connection.github.arn
  invocation_endpoint              = "https://api.github.com/repos/${var.github_repo}/actions/workflows/${var.workflow_file}/dispatches"
  http_method                      = "POST"
  invocation_rate_limit_per_second = 1
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

data "aws_caller_identity" "current" {}

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

resource "aws_iam_role" "events" {
  name = local.name
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }
    }]
  })
}

resource "aws_iam_role_policy" "invoke" {
  name = "invoke-api-destination"
  role = aws_iam_role.events.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "events:InvokeApiDestination"
      Resource = aws_cloudwatch_event_api_destination.dispatch.arn
    }]
  })
}

resource "aws_cloudwatch_event_target" "dispatch" {
  rule     = aws_cloudwatch_event_rule.schedule.name
  arn      = aws_cloudwatch_event_api_destination.dispatch.arn
  role_arn = aws_iam_role.events.arn
  input    = jsonencode({ ref = var.github_ref })

  http_target {
    header_parameters = {
      Accept                 = "application/vnd.github+json"
      "Content-Type"         = "application/json"
      "User-Agent"           = "source-cooperative-status-scheduler"
      "X-GitHub-Api-Version" = "2022-11-28"
    }
  }

  retry_policy {
    maximum_retry_attempts       = 2
    maximum_event_age_in_seconds = 300
  }

  dead_letter_config {
    arn = aws_sqs_queue.failed.arn
  }

  depends_on = [aws_iam_role_policy.invoke]
}

output "rule_name" {
  value = aws_cloudwatch_event_rule.schedule.name
}

output "failed_events_queue_url" {
  description = "Messages here mean a scheduled dispatch could not be delivered."
  value       = aws_sqs_queue.failed.url
}
