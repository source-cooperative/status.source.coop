// Cron-triggered Worker that asks GitHub to run the Upptime "Uptime CI" workflow.
//
// GitHub's own `schedule:` trigger is best-effort and in practice fires every
// 30-60 minutes. A workflow_dispatch from an external scheduler runs promptly.
// See ../../README.md for why this exists next to the AWS scheduler.

const API_VERSION = "2022-11-28";

export async function dispatch(env, fetchImpl = fetch) {
  const { GITHUB_REPO, GITHUB_REF, WORKFLOW_FILE, DISPATCH_TOKEN } = env;
  if (!DISPATCH_TOKEN) {
    throw new Error("DISPATCH_TOKEN secret is not set");
  }

  const url = `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`;
  const init = {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${DISPATCH_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "source-cooperative-status-scheduler",
      "X-GitHub-Api-Version": API_VERSION,
    },
    body: JSON.stringify({ ref: GITHUB_REF }),
  };

  // One retry for transient failures (network error or 5xx). A 4xx means the
  // token, repo or workflow name is wrong, which a retry cannot fix.
  let response;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      response = await fetchImpl(url, init);
    } catch (err) {
      if (attempt === 2) throw err;
      continue;
    }
    if (response.status < 500) break;
  }

  // GitHub answers 204 No Content when the dispatch is accepted.
  if (response.status !== 204) {
    const detail = await response.text().catch(() => "");
    throw new Error(`workflow dispatch failed: HTTP ${response.status} ${detail}`.trim());
  }
}

export default {
  async scheduled(_controller, env, ctx) {
    // A thrown error is recorded as a failed invocation in Workers logs/metrics.
    ctx.waitUntil(dispatch(env));
  },

  // No public surface: this Worker only runs on its cron trigger.
  async fetch() {
    return new Response("Not found", { status: 404 });
  },
};
