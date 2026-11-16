// Shared by the Cloudflare Worker and the AWS Lambda: authenticate as a GitHub
// App and dispatch the Upptime "Uptime CI" workflow. Web Crypto + fetch only,
// so it runs unchanged on Workers and Node 20+.

const API = "https://api.github.com";
const HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "source-cooperative-status-scheduler",
  "X-GitHub-Api-Version": "2022-11-28",
};

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
const enc = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

// GitHub issues PKCS#1 keys ("BEGIN RSA PRIVATE KEY"); Web Crypto needs PKCS#8:
//   openssl pkcs8 -topk8 -nocrypt -in app.pem -out app.pkcs8.pem
async function signJwt(clientId, pem) {
  if (!pem.includes("BEGIN PRIVATE KEY")) {
    throw new Error("GitHub App private key must be PKCS#8 (BEGIN PRIVATE KEY); convert with openssl pkcs8 -topk8 -nocrypt");
  }
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const now = Math.floor(Date.now() / 1000);
  const body = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iss: clientId, iat: now - 60, exp: now + 540 })}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(body));
  return `${body}.${b64url(sig)}`;
}

// Installation token narrowed to Actions: write on the one repo, so a leaked
// token can do no more than trigger workflow runs (the App itself can do more).
export async function mintInstallationToken({ clientId, installationId, privateKey, repo }, fetchImpl = fetch) {
  if (!clientId || !installationId || !privateKey) {
    throw new Error("GitHub App client id, installation id and private key are all required");
  }
  const jwt = await signJwt(clientId, privateKey);
  const res = await fetchImpl(`${API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { ...HEADERS, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ repositories: [repo.split("/")[1]], permissions: { actions: "write" } }),
  });
  if (res.status !== 201) {
    throw new Error(`installation token request failed: HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());
  }
  return (await res.json()).token;
}

export async function dispatchWorkflow({ token, repo, ref, workflow }, fetchImpl = fetch) {
  const url = `${API}/repos/${repo}/actions/workflows/${workflow}/dispatches`;
  const init = {
    method: "POST",
    headers: { ...HEADERS, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ref }),
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

// True if the workflow already has a run created in the last `windowSeconds`
// (queued, running or finished). Both schedulers fire on the same ticks, so
// whichever gets here second sees its sibling's run and stands down.
export async function recentRunExists({ token, repo, workflow, windowSeconds = 120 }, fetchImpl = fetch) {
  const since = new Date(Date.now() - windowSeconds * 1000).toISOString().replace(/\.\d+Z$/, "Z");
  const res = await fetchImpl(
    `${API}/repos/${repo}/actions/workflows/${workflow}/runs?per_page=1&created=${encodeURIComponent(`>=${since}`)}`,
    { headers: { ...HEADERS, Authorization: `Bearer ${token}` } },
  );
  if (res.status !== 200) {
    // Fail open: a duplicate run is harmless, a missed one is not.
    return false;
  }
  return (await res.json()).total_count > 0;
}

// Mint a token, then dispatch unless a sibling already did. `cfg` holds the App
// credentials plus repo/ref/workflow. Returns "dispatched" or "skipped".
export async function run(cfg, fetchImpl = fetch) {
  const token = await mintInstallationToken(cfg, fetchImpl);
  if (await recentRunExists({ ...cfg, token }, fetchImpl)) return "skipped";
  await dispatchWorkflow({ ...cfg, token }, fetchImpl);
  return "dispatched";
}
