// Cron-triggered Worker that asks GitHub to run the Upptime "Uptime CI" workflow.
//
// GitHub's own `schedule:` trigger is best-effort and in practice fires every
// 30-60 minutes. A workflow_dispatch from an external scheduler runs promptly.
// See ../../README.md for why this exists next to the AWS scheduler.

import { run } from "../../shared/github.mjs";

export default {
  async scheduled(_controller, env) {
    // Awaited (not waitUntil) so a thrown error fails the cron invocation in
    // Workers logs/metrics instead of only surfacing as a background exception.
    await run({
      clientId: env.GH_APP_CLIENT_ID,
      installationId: env.GH_APP_INSTALLATION_ID,
      privateKey: env.GH_APP_PRIVATE_KEY,
      repo: env.GITHUB_REPO,
      ref: env.GITHUB_REF,
      workflow: env.WORKFLOW_FILE,
    });
  },

  // No public surface: this Worker only runs on its cron trigger.
  async fetch() {
    return new Response("Not found", { status: 404 });
  },
};
