import { test } from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import { checkFallbackError, isRequestError } from "../open-sse/services/accountFallback.js";
import { handleComboChat } from "../open-sse/services/combo.js";
import { TRANSIENT_COOLDOWN_MS } from "../open-sse/config/errorConfig.js";
import { connectTimeoutForBody } from "../open-sse/config/runtimeConfig.js";
import { BaseExecutor } from "../open-sse/executors/base.js";

// Error text as chatCore hands it to the account loop: provider tag + upstream body.
const wrap = (status, body) => `[openai-compatible-chat-x/model] [${status}]: ${body}`;

test("context-window 400 from boltz is a request error: no cooldown", () => {
  const text = wrap(400, JSON.stringify({
    message: "Invalid request", type: "Bad Request", code: 400,
    details: { type: "context_length", limit: 1048572, actual: 1099691 },
  }));
  const r = checkFallbackError(400, text);
  assert.equal(r.requestError, true);
  assert.equal(r.cooldownMs, 0);
  assert.equal(r.newBackoffLevel, undefined);
});

test("413 is a request error whatever the body says", () => {
  assert.equal(checkFallbackError(413, wrap(413, "Failed to buffer the request body: length limit exceeded")).requestError, true);
  assert.equal(checkFallbackError(413, "").requestError, true);
});

test("other providers' context-size messages on 400/422 are request errors", () => {
  assert.equal(isRequestError(400, "this model's maximum context length is 128000 tokens"), true);
  assert.equal(isRequestError(400, "prompt is too long: 250000 tokens > 200000 maximum"), true);
  assert.equal(isRequestError(400, "input token count exceeds the maximum number of tokens allowed"), true);
  assert.equal(isRequestError(422, "request entity too large"), true);
});

test("a generic 400 is not a request error: it keeps the account fallback", () => {
  const r = checkFallbackError(400, wrap(400, "Invalid request"));
  assert.equal(r.requestError, undefined);
  assert.equal(r.shouldFallback, true);
  assert.equal(r.cooldownMs, TRANSIENT_COOLDOWN_MS);
});

test("Gemini answers a bad API key with 400: still falls back to another account", () => {
  const r = checkFallbackError(400, wrap(400, '{"error":{"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}'));
  assert.equal(r.requestError, undefined);
  assert.equal(r.shouldFallback, true);
  assert.ok(r.cooldownMs > 0);
});

test("a 429 'request too large' on tokens per minute stays a rate limit with backoff", () => {
  const text = wrap(429, "Request too large for gpt-4 on tokens per min (TPM): Limit 10000, Requested 30000, rate limit");
  const r = checkFallbackError(429, text);
  assert.equal(r.requestError, undefined);
  assert.ok(r.cooldownMs > 0);
  assert.equal(r.newBackoffLevel, 1);
  // same wording without the rate-limit phrase: the status alone keeps it out of the request-error path
  const bare = checkFallbackError(429, wrap(429, "Request too large for gpt-4 on tokens per min"));
  assert.equal(bare.requestError, undefined);
  assert.ok(bare.newBackoffLevel >= 1);
});

test("boltz 429 'all upstreams cooling down' is still a backoff", () => {
  const r = checkFallbackError(429, wrap(429, "too many requests: all upstreams cooling down; retry shortly"));
  assert.equal(r.requestError, undefined);
  assert.equal(r.newBackoffLevel, 1);
});

test("5xx and network failures keep the transient cooldown", () => {
  for (const [status, text] of [[502, wrap(502, "fetch failed (cause: UND_ERR_SOCKET: other side closed)")], [500, wrap(500, "internal error")]]) {
    const r = checkFallbackError(status, text);
    assert.equal(r.requestError, undefined);
    assert.equal(r.cooldownMs, TRANSIENT_COOLDOWN_MS);
  }
});

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

test("combo: a model that is locked reports its Retry-After header on the combined 503", async () => {
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "hi" }] },
    models: ["a/model"],
    handleSingleModel: async () => json(503, { error: { message: "locked (reset after 12s)" } }, { "Retry-After": "12" }),
    log: silent,
    comboName: "retry-after-header",
    comboStrategy: "fallback",
  });
  assert.equal(res.status, 503);
  const sec = Number(res.headers.get("retry-after"));
  assert.ok(sec >= 11 && sec <= 12, `Retry-After was ${res.headers.get("retry-after")}`);
  const { error } = await res.json();
  assert.equal(error.message.match(/reset after/g).length, 1, `hint repeated: ${error.message}`);
});

test("combo: a context-length 400 keeps its status and still lets the next model try", async () => {
  const tried = [];
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "hi" }] },
    models: ["small/model", "big/model"],
    handleSingleModel: async (_b, m) => {
      tried.push(m);
      if (m === "small/model") return json(400, { error: { message: wrap(400, '{"details":{"type":"context_length"}}') } });
      return json(200, { choices: [{ message: { content: "ok" } }] });
    },
    log: silent,
    comboName: "ctx-fallthrough",
    comboStrategy: "fallback",
  });
  assert.deepEqual(tried, ["small/model", "big/model"]);
  assert.equal(res.status, 200);

  const only = await handleComboChat({
    body: { messages: [{ role: "user", content: "hi" }] },
    models: ["small/model"],
    handleSingleModel: async () => json(400, { error: { message: wrap(400, '{"details":{"type":"context_length"}}') } }),
    log: silent,
    comboName: "ctx-only",
    comboStrategy: "fallback",
  });
  assert.equal(only.status, 400, "the client must see 400, not a blanket 503");
});

test("connect timeout grows with the request body and is capped", () => {
  assert.equal(connectTimeoutForBody(0, 60_000), 60_000);
  assert.equal(connectTimeoutForBody(770 * 1024, 60_000), 60_000 + 770 * 100);
  assert.equal(connectTimeoutForBody(50 * 1024 * 1024, 60_000), 300_000);
  // a base above the cap is never lowered
  assert.equal(connectTimeoutForBody(1024, 400_000), 400_000);
});

test("an upstream that never answers is tried once, not resent three more times", async () => {
  let hits = 0;
  const server = http.createServer(() => { hits++; /* never answers */ });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const executor = new BaseExecutor("openai-compatible-chat-test", { timeoutMs: 200 });
  const t0 = Date.now();
  try {
    await assert.rejects(
      executor.execute({
        model: "m", body: { messages: [{ role: "user", content: "hi" }] }, stream: true,
        credentials: { apiKey: "k", providerSpecificData: { baseUrl: `http://127.0.0.1:${port}/v1` } },
        signal: null, log: null,
      }),
      /connect timeout/
    );
  } finally {
    server.closeAllConnections();
    server.close();
  }
  assert.equal(hits, 1, "a connect timeout must not be retried");
  assert.ok(Date.now() - t0 < 2000, "no retry delay (3s each) may be spent");
});
