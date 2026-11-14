# Schedulers

Upptime's `uptime.yml` asks GitHub to run every 5 minutes, but GitHub's `schedule:` trigger is best-effort. Here it ran about every 40 minutes (33 of 253 expected runs in 21 hours), which Upptime's own docs describe: [GitHub Actions workflow not triggering at scheduled time](https://upptime.js.org/blog/2021/01/22/github-actions-schedule-not-working/).

Upptime's recommended fix is an external scheduler that calls the GitHub `workflow_dispatch` API. We run two, on different providers, so one provider's outage does not stop the checks. GitHub's native cron stays in place as a third trigger.

| Directory | Provider | Fires at minutes | Deployed with |
| --- | --- | --- | --- |
| `schedulers/aws` | EventBridge rule, API destination (no Lambda) | 0, 5, 10, … | Terraform |
| `schedulers/cloudflare` | Worker cron trigger | 2, 7, 12, … | Wrangler |

While both are healthy a check starts about every 2.5 minutes. Extra dispatches are harmless: the Upptime workflow queues runs rather than cancelling them, and Actions minutes are free on public repos.

Both exist to keep the status page independent of the things it monitors, so each is its own failure domain. Keep the AWS region off the one that hosts the data being monitored.

## Deployment

Each provider has its own workflow, triggered only when its directory (or its workflow file) changes:

- `.github/workflows/deploy-scheduler-aws.yml`: PRs run `terraform plan`; pushes to `master` apply.
- `.github/workflows/deploy-scheduler-cloudflare.yml`: PRs run tests and a `wrangler deploy --dry-run`; pushes to `master` deploy.

Both also have `workflow_dispatch` for a manual run.

## One-time setup

### Dispatch tokens

Create one fine-grained personal access token per provider, so one leaking or expiring breaks only one trigger. Scope each to this repository only, with **Actions: read and write**. Set an expiry and put the date in a calendar: an expired token fails silently from the status page's point of view.

Repository **secrets**: `SCHEDULER_TOKEN_AWS`, `SCHEDULER_TOKEN_CLOUDFLARE`.

### AWS

- An S3 bucket for Terraform state (versioned, encrypted). The state holds the dispatch token, so restrict access to it.
- An IAM role that GitHub Actions can assume through OIDC for this repo, allowed to manage EventBridge rules, connections and API destinations, IAM roles, SQS queues and the state bucket.

Repository **variables**: `SCHEDULER_AWS_ROLE_ARN`, `SCHEDULER_TF_STATE_BUCKET`, `SCHEDULER_TF_STATE_REGION`.

Delivery failures after retries go to the `source-status-scheduler-failed` SQS queue (`terraform output failed_events_queue_url`). Messages there mean a dispatch did not reach GitHub.

### Cloudflare

An API token with **Workers Scripts: Edit** for the account.

Repository **secret**: `CLOUDFLARE_API_TOKEN`. Repository **variable**: `CLOUDFLARE_ACCOUNT_ID`.

The deploy step also writes `SCHEDULER_TOKEN_CLOUDFLARE` into the Worker as its `DISPATCH_TOKEN` secret. Failed dispatches show up as failed cron invocations in the Workers dashboard.

## Local checks

```sh
cd schedulers/cloudflare && npm ci && npm test
cd schedulers/aws && terraform fmt -check && terraform init -backend=false && terraform validate
```

## Not covered

Nothing alerts if every trigger stops. A dead-man's-switch (for example healthchecks.io, pinged by the schedulers and alerting when pings stop) would close that gap.
