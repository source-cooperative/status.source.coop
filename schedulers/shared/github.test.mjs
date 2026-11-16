import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { run, dispatchWorkflow, mintInstallationToken } from "./github.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" });
const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" });

const cfg = {
  clientId: "Iv23liTEST",
  installationId: "123",
  privateKey: pkcs8,
  repo: "source-cooperative/status.source.coop",
  ref: "master",
  workflow: "uptime.yml",
};
const res = (status, body = "") => new Response(body || null, { status });

test("mints a narrowed token with a verifiable RS256 JWT, then dispatches with it", async () => {
  const calls = [];
  await run(cfg, async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1 ? res(201, JSON.stringify({ token: "inst-token" })) : res(204);
  });

  const [mint, dispatch] = calls;
  assert.equal(mint.url, "https://api.github.com/app/installations/123/access_tokens");
  assert.deepEqual(JSON.parse(mint.init.body), {
    repositories: ["status.source.coop"],
    permissions: { actions: "write" },
  });
  const [h, p, s] = mint.init.headers.Authorization.replace("Bearer ", "").split(".");
  const claims = JSON.parse(Buffer.from(p, "base64url"));
  assert.equal(claims.iss, "Iv23liTEST");
  assert.ok(claims.exp - claims.iat <= 600);
  const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s, "base64url"));
  assert.ok(ok, "JWT signature verifies against the public key");

  assert.equal(
    dispatch.url,
    "https://api.github.com/repos/source-cooperative/status.source.coop/actions/workflows/uptime.yml/dispatches",
  );
  assert.equal(dispatch.init.headers.Authorization, "Bearer inst-token");
  assert.deepEqual(JSON.parse(dispatch.init.body), { ref: "master" });
});

test("rejects a PKCS#1 key with a helpful message", async () => {
  await assert.rejects(mintInstallationToken({ ...cfg, privateKey: pkcs1 }, async () => res(201)), /PKCS#8/);
});

test("fails when credentials are missing", async () => {
  await assert.rejects(mintInstallationToken({ ...cfg, installationId: "" }, async () => res(201)), /required/);
});

test("surfaces a failed token request", async () => {
  await assert.rejects(mintInstallationToken(cfg, async () => res(401, "Bad credentials")), /HTTP 401 Bad credentials/);
});

const d = { token: "t", repo: cfg.repo, ref: "master", workflow: "uptime.yml" };

test("retries once on a 5xx and then succeeds", async () => {
  let n = 0;
  await dispatchWorkflow(d, async () => (++n === 1 ? res(502) : res(204)));
  assert.equal(n, 2);
});

test("retries once on a network error", async () => {
  let n = 0;
  await dispatchWorkflow(d, async () => {
    if (++n === 1) throw new TypeError("network down");
    return res(204);
  });
  assert.equal(n, 2);
});

test("fails after two 5xx responses", async () => {
  let n = 0;
  await assert.rejects(dispatchWorkflow(d, async () => (++n, res(503, "unavailable"))), /HTTP 503/);
  assert.equal(n, 2);
});

test("does not retry a 4xx", async () => {
  let n = 0;
  await assert.rejects(dispatchWorkflow(d, async () => (++n, res(404, "Not Found"))), /HTTP 404/);
  assert.equal(n, 1);
});
