import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../src/index.js";

const env = {
  GITHUB_REPO: "source-cooperative/status.source.coop",
  GITHUB_REF: "master",
  WORKFLOW_FILE: "uptime.yml",
  DISPATCH_TOKEN: "t0ken",
};

const res = (status, body = "") => new Response(body || null, { status });

test("posts a workflow dispatch to the right URL with auth and ref", async () => {
  const calls = [];
  await dispatch(env, async (url, init) => {
    calls.push({ url, init });
    return res(204);
  });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.github.com/repos/source-cooperative/status.source.coop/actions/workflows/uptime.yml/dispatches",
  );
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer t0ken");
  assert.equal(calls[0].init.headers["User-Agent"], "source-cooperative-status-scheduler");
  assert.deepEqual(JSON.parse(calls[0].init.body), { ref: "master" });
});

test("retries once on a 5xx and then succeeds", async () => {
  let n = 0;
  await dispatch(env, async () => (++n === 1 ? res(502) : res(204)));
  assert.equal(n, 2);
});

test("retries once on a network error", async () => {
  let n = 0;
  await dispatch(env, async () => {
    if (++n === 1) throw new TypeError("network down");
    return res(204);
  });
  assert.equal(n, 2);
});

test("fails after two 5xx responses", async () => {
  let n = 0;
  await assert.rejects(
    dispatch(env, async () => (++n, res(503, "unavailable"))),
    /HTTP 503/,
  );
  assert.equal(n, 2);
});

test("does not retry a 4xx and surfaces it", async () => {
  let n = 0;
  await assert.rejects(
    dispatch(env, async () => (++n, res(401, "Bad credentials"))),
    /HTTP 401 Bad credentials/,
  );
  assert.equal(n, 1);
});

test("fails loudly when the token secret is missing", async () => {
  await assert.rejects(
    dispatch({ ...env, DISPATCH_TOKEN: undefined }, async () => res(204)),
    /DISPATCH_TOKEN/,
  );
});
