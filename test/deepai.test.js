import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepai-test-"));
process.env.DATA_DIR = dataDir;

const client = await import("../open-sse/services/deepaiClient.js");
const { DeepAIExecutor } = await import("../open-sse/executors/deepai.js");
const auth = await import("../open-sse/services/deepaiAuth.js");
const { PROVIDERS } = await import("../open-sse/providers/index.js");

test("registry: deepai uses the api-key header and the OpenAI chat route", () => {
  const t = PROVIDERS.deepai;
  assert.equal(t.baseUrl, "https://api.deepai.org/deepai_code/chat/completions");
  assert.equal(t.format, "openai");
  assert.deepEqual({ header: t.auth.header, scheme: t.auth.scheme }, { header: "api-key", scheme: "raw" });
});

test("machine id is one stable sha256 digest shared by every account", async () => {
  const a = await client.deepaiMachineId();
  const b = await client.deepaiMachineId();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, b);
  const headersA = await client.deepaiLaneHeaders();
  const headersB = await client.deepaiLaneHeaders();
  assert.equal(headersA[client.DEEPAI_MACHINE_HEADER], headersB[client.DEEPAI_MACHINE_HEADER]);
  assert.equal(headersA["X-DeepAI-Code-Theos"], client.DEEPAI_LANE_VERSION);
});

test("beacon reports only version and uptime, never presence signals", () => {
  assert.match(client.deepaiBeacon(), /^v=\d+\.\d+\.\d+;up=\d+$/);
  assert.doesNotMatch(client.deepaiBeacon(), /focus|pi=/);
});

test("normalizeDeepAIModels keeps valid unique ids and drops junk", () => {
  const out = client.normalizeDeepAIModels({
    models: [
      { id: "glm-5.3-flash", name: "GLM 5.3 Flash", contextWindow: 1048576, maxTokens: 131072 },
      { id: "glm-5.3-flash", name: "dup" },
      { id: "bad id with spaces", name: "x" },
      { id: 42 },
      { id: "deepai-cyber" },
    ],
  });
  assert.deepEqual(out.map((m) => m.id), ["glm-5.3-flash", "deepai-cyber"]);
  assert.equal(out[0].contextLength, 1048576);
  assert.equal(out[1].name, "deepai-cyber");
  assert.deepEqual(client.normalizeDeepAIModels({ models: [] }), []);
  assert.deepEqual(client.normalizeDeepAIModels(null), []);
});

test("executor sends only api-key and lane headers; check-in and beacon stay on /theos", async () => {
  const executor = new DeepAIExecutor();
  executor._laneHeaders = await client.deepaiLaneHeaders();
  const headers = executor.buildHeaders({ accessToken: "key-abc" }, true, "u", "glm-5.3-flash", {});
  assert.equal(headers["api-key"], "key-abc");
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers["X-DeepAI-Code-Theos"], client.DEEPAI_LANE_VERSION);
  assert.match(headers[client.DEEPAI_MACHINE_HEADER], /^[0-9a-f]{64}$/);
  // the desktop app passes checkInHeaders() only for /theos
  assert.equal(headers[client.DEEPAI_BEACON_HEADER], undefined);
  assert.equal(headers[client.DEEPAI_CHECK_IN_HEADER], undefined);
  assert.equal(headers.Accept, "text/event-stream");
});

test("oauth: authorize URL carries state and the loopback port", async () => {
  const state = auth.newDeepAIState();
  assert.match(state, /^[0-9a-f]{64}$/);
  const url = new URL(auth.buildDeepAISignInUrl({}, "http://127.0.0.1:41755/auth-callback", state));
  assert.equal(url.origin + url.pathname, "https://api.deepai.org/deepai_code/desktop_auth/");
  assert.equal(url.searchParams.get("port"), "41755");
  assert.equal(url.searchParams.get("state"), state);
  assert.throws(() => auth.buildDeepAISignInUrl({}, "https://admin.example/callback", "s"), /loopback callback port/);
});

test("oauth: exchange stores the api_key as the access token, labelled per username", async () => {
  const realFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ api_key: "dk_live_123", username: "alice", is_pro: true }), { status: 200 });
  };
  try {
    const tokens = await auth.exchangeDeepAICode({}, " one-time-code ");
    assert.equal(seen.url, "https://api.deepai.org/deepai_code/desktop_auth/exchange/");
    assert.deepEqual(JSON.parse(seen.init.body), { code: "one-time-code" });
    const mapped = auth.mapDeepAITokens(tokens);
    assert.equal(mapped.accessToken, "dk_live_123");
    assert.equal(mapped.refreshToken, null);
    assert.equal(mapped.expiresIn, null);
    assert.equal(mapped.email, "deepai-user-alice");
    assert.equal(mapped.providerSpecificData.isPro, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("oauth: refused or malformed exchanges fail with a fixed message", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("{}", { status: 400 });
    await assert.rejects(auth.exchangeDeepAICode({}, "x"), /expired or was already used/);
    globalThis.fetch = async () => new Response(JSON.stringify({ api_key: "bad\nkey" }), { status: 200 });
    await assert.rejects(auth.exchangeDeepAICode({}, "x"), /invalid sign-in response/);
    await assert.rejects(auth.exchangeDeepAICode({}, "  "), /Missing DeepAI sign-in code/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ─── check-in against a local stand-in for /theos ────────────────────────────
import http from "node:http";

async function withTheos(handler, run) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, headers: req.headers });
    handler(req, res, hits.length);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const prev = process.env.DEEPAI_LOCAL_TEST_ORIGIN;
  process.env.DEEPAI_LOCAL_TEST_ORIGIN = `http://127.0.0.1:${server.address().port}`;
  client.resetDeepAIStateForTests();
  try {
    await run(hits);
  } finally {
    if (prev === undefined) delete process.env.DEEPAI_LOCAL_TEST_ORIGIN;
    else process.env.DEEPAI_LOCAL_TEST_ORIGIN = prev;
    await new Promise((resolve) => server.close(resolve));
  }
}

const NONCE_A = "a".repeat(32);
const NONCE_B = "b".repeat(32);

test("check-in: nonce is fetched once per account and reused while fresh", async () => {
  await withTheos((req, res, n) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ enabled: true, lane_version: 7, check_in: { nonce: n === 1 ? NONCE_A : NONCE_B, seconds: 600 } }));
  }, async (hits) => {
    assert.equal(client.currentCheckInNonce("key-1"), null);
    await Promise.all([client.ensureDeepAICheckIn("key-1"), client.ensureDeepAICheckIn("key-1")]);
    assert.equal(hits.length, 1, "concurrent callers share one request");
    assert.equal(hits[0].url, "/deepai_code/theos");
    assert.equal(hits[0].headers["api-key"], "key-1");
    assert.equal(hits[0].headers["x-deepai-code-theos"], client.DEEPAI_LANE_VERSION);
    assert.match(hits[0].headers["x-deepai-code-machine"], /^[0-9a-f]{64}$/);
    assert.doesNotMatch(hits[0].headers["x-deepai-code-beacon"], /focus|pi=/);
    assert.equal(client.currentCheckInNonce("key-1"), NONCE_A);

    await client.ensureDeepAICheckIn("key-1");
    assert.equal(hits.length, 1, "a fresh check-in is not renewed");

    await client.ensureDeepAICheckIn("key-2");
    assert.equal(hits.length, 2, "each account checks in on its own");
    assert.equal(client.currentCheckInNonce("key-2"), NONCE_B);
    assert.equal(client.currentCheckInNonce("key-1"), NONCE_A);
    // every account reports the deployment's single machine digest
    assert.equal(hits[0].headers["x-deepai-code-machine"], hits[1].headers["x-deepai-code-machine"]);
  });
});

test("check-in: a refused or failing /theos never throws and leaves no nonce", async () => {
  await withTheos((req, res) => {
    res.statusCode = 403;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { code: "machine_required" } }));
  }, async () => {
    await client.ensureDeepAICheckIn("key-x");
    assert.equal(client.currentCheckInNonce("key-x"), null);
  });
  client.resetDeepAIStateForTests();
  process.env.DEEPAI_LOCAL_TEST_ORIGIN = "http://127.0.0.1:1";
  try {
    await client.ensureDeepAICheckIn("key-y");
    assert.equal(client.currentCheckInNonce("key-y"), null);
  } finally {
    delete process.env.DEEPAI_LOCAL_TEST_ORIGIN;
  }
});

test("local test origin only accepts a loopback address", () => {
  const prev = process.env.DEEPAI_LOCAL_TEST_ORIGIN;
  try {
    for (const bad of ["https://evil.example", "http://127.0.0.1", "http://localhost:8080", "http://127.0.0.1:80/x", "http://10.0.0.5:8080"]) {
      process.env.DEEPAI_LOCAL_TEST_ORIGIN = bad;
      assert.equal(client.deepaiModelBase(), "https://api.deepai.org/deepai_code", bad);
    }
    process.env.DEEPAI_LOCAL_TEST_ORIGIN = "http://127.0.0.1:41999";
    assert.equal(client.deepaiModelBase(), "http://127.0.0.1:41999/deepai_code");
    delete process.env.DEEPAI_LOCAL_TEST_ORIGIN;
    assert.equal(client.deepaiModelBase(), "https://api.deepai.org/deepai_code");
  } finally {
    if (prev === undefined) delete process.env.DEEPAI_LOCAL_TEST_ORIGIN;
    else process.env.DEEPAI_LOCAL_TEST_ORIGIN = prev;
  }
});

test("check-in: a refused account is not retried on every request (backoff)", async () => {
  await withTheos((req, res) => {
    res.statusCode = 403;
    res.end(JSON.stringify({ error: { code: "machine_required" } }));
  }, async (hits) => {
    await client.ensureDeepAICheckIn("key-refused");
    await client.ensureDeepAICheckIn("key-refused");
    await client.ensureDeepAICheckIn("key-refused");
    assert.equal(hits.length, 1);
    assert.equal(client.currentCheckInNonce("key-refused"), null);
  });
});

test("check-in: a failed renewal keeps the previous nonce until it expires", async () => {
  let n = 0;
  await withTheos((req, res) => {
    n++;
    if (n === 1) {
      res.end(JSON.stringify({ enabled: true, check_in: { nonce: NONCE_A, seconds: 600 } }));
    } else {
      res.statusCode = 500;
      res.end("{}");
    }
  }, async (hits) => {
    await client.ensureDeepAICheckIn("key-renew");
    assert.equal(client.currentCheckInNonce("key-renew"), NONCE_A);
    // age the entry past half its lifetime so the next call renews
    const realNow = Date.now;
    Date.now = () => realNow() + 400 * 1000;
    try {
      await client.ensureDeepAICheckIn("key-renew");
      assert.equal(hits.length, 2);
      assert.equal(hits[1].headers["x-deepai-code-check-in"], NONCE_A, "renewal presents the previous nonce");
      assert.equal(client.currentCheckInNonce("key-renew"), NONCE_A, "old nonce still valid");
    } finally {
      Date.now = realNow;
    }
  });
});

test("resolveDeepAIModels: live catalog, cached, and bundled fallback", async () => {
  let calls = 0;
  await withTheos((req, res) => {
    calls++;
    if (req.headers["api-key"] === "key-bad") {
      res.statusCode = 401;
      return res.end("{}");
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ models: [{ id: "live-model", name: "Live", contextWindow: 1000 }] }));
  }, async () => {
    const live = await client.resolveDeepAIModels({ accessToken: "key-ok" });
    assert.equal(live.source, "live");
    assert.deepEqual(live.models.map((m) => m.id), ["live-model"]);
    const cached = await client.resolveDeepAIModels({ accessToken: "key-ok" });
    assert.equal(cached.source, "cache");
    assert.equal(calls, 1);
    const fallback = await client.resolveDeepAIModels({ apiKey: "key-bad" });
    assert.equal(fallback.source, "static");
    assert.deepEqual(fallback.models, client.DEEPAI_STATIC_MODELS);
  });
});

test("oauth: without a username the label comes from the key, stable across sign-ins", () => {
  const a = auth.mapDeepAITokens({ access_token: "dk_1", username: "", is_pro: false });
  const b = auth.mapDeepAITokens({ access_token: "dk_1", username: "", is_pro: false });
  const c = auth.mapDeepAITokens({ access_token: "dk_2", username: "", is_pro: false });
  assert.equal(a.email, b.email);
  assert.notEqual(a.email, c.email);
  assert.match(a.email, /^deepai-user-[0-9a-f]{10}$/);
  const named = auth.mapDeepAITokens({ access_token: "dk_1", username: "alice", is_pro: false });
  assert.equal(named.name, "alice");
  assert.equal(named.email, "deepai-user-alice");
});

test("static catalog mirrors the registry entry", () => {
  assert.deepEqual(client.DEEPAI_STATIC_MODELS.map((m) => m.id), PROVIDERS_MODELS_IDS());
  function PROVIDERS_MODELS_IDS() {
    return ["glm-5.3-flash", "deepseek-v4.1-flash", "deepai-cyber", "muse-ember"];
  }
});
