// EventBridge-invoked Lambda: mint a GitHub App installation token and dispatch
// the Upptime workflow. Packaged by Terraform together with ../../shared/github.mjs.

import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { run } from "./github.mjs";

const sm = new SecretsManagerClient({});
let privateKey; // cached across warm invocations

export const handler = async () => {
  privateKey ??= (await sm.send(new GetSecretValueCommand({ SecretId: process.env.KEY_SECRET_ARN }))).SecretString;
  // A thrown error fails the invocation; Lambda retries twice, then the event
  // lands in the failed-events SQS queue.
  await run({
    clientId: process.env.GH_APP_CLIENT_ID,
    installationId: process.env.GH_APP_INSTALLATION_ID,
    privateKey,
    repo: process.env.GITHUB_REPO,
    ref: process.env.GITHUB_REF,
    workflow: process.env.WORKFLOW_FILE,
  });
};
