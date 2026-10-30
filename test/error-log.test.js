// Error log (spec error-log): what is kept for a failed request, what is left out,
// and how the log stays bounded. Throwaway SQLite, relative imports only.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-errlog-test-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const { compactBody, describeBody, maskSecrets } = await import("../src/lib/errorLog/compact.js");
const { recordErrorLog, classifySource, __resetPruneClock } = await import("../src/lib/errorLog/record.js");
const repo = await import("../src/lib/db/repos/errorLogsRepo.js");
const { createTrace, runWithTrace, noteClientBody, noteUpstreamBody, noteAttempt, getTrace } =
  await import("../open-sse/utils/errorTrace.js");
const { createWithErrorLog } = await import("../src/lib/errorLog/wrap.js");

let db;
before(async () => { db = await getAdapter(); });
after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(async () => {
  db.run(`DELETE FROM errorLogs`);
  await repo.setErrorLogConfig({ enabled: true, storePrompt: true, retentionDays: 14, maxRows: 1000, maxBodyKB: 64 });
  __resetPruneClock();
});

const KEY = "sk-6920ba17c2ee1d17-9bod82-05263e46";

// ── compaction and masking ─────────────────────────────────────────────────

test("secrets are masked in text and in credential-named fields", () => {
  assert.equal(maskSecrets(`Authorization: Bearer ${KEY}`), "Authorization: Bearer [redacted]");
  assert.equal(maskSecrets("call https://x/v1/models?key=AIzaSyABC123&alt=sse"), "call https://x/v1/models?key=[redacted]&alt=sse");
  assert.ok(!maskSecrets(`use ${KEY} here`).includes("6920ba17"));
  assert.ok(!maskSecrets("ak_live_606584ed43528ef468aaed8512d42a50bd53d4f30da74565").includes("606584ed"));
  assert.equal(maskSecrets('{"api_key":"abc123","x":1}'), '{"api_key":"[redacted]","x":1}');

  const { value } = compactBody({ model: "m", api_key: "plain", messages: [{ role: "user", content: `token ${KEY}` }] });
  assert.equal(value.api_key, "[redacted]");
  assert.ok(!JSON.stringify(value).includes("6920ba17"));
});

test("compaction keeps the structure and cuts only the bulk", () => {
  const body = {
    model: "m", temperature: 0.2, stream: true,
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: [{ type: "text", text: "x".repeat(50_000) }, { type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(30_000)}` } }] },
    ],
  };
  const { value, truncated, originalBytes } = compactBody(body, { maxBytes: 64 * 1024 });
  assert.equal(truncated, true);
  assert.ok(originalBytes > 80_000);
  assert.equal(value.model, "m");
  assert.equal(value.temperature, 0.2);
  assert.equal(value.messages[0].content, "be brief");
  assert.match(value.messages[1].content[0].text, /chars cut/);
  assert.match(value.messages[1].content[1].image_url.url, /^\[data:image\/png, 30\d{3} chars\]$/);
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 64 * 1024);
});

test("a long history keeps its first and last turns when strings alone cannot fit it", () => {
  const messages = Array.from({ length: 4000 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i} ` + "w ".repeat(40) }));
  const { value, truncated } = compactBody({ model: "m", messages }, { maxBytes: 32 * 1024 });
  assert.equal(truncated, true);
  assert.ok(value.messages.length < 100);
  assert.match(value.messages[0].content, /^turn 0 /);
  assert.match(value.messages.at(-1).content, /^turn 3999 /);
  assert.ok(value.messages.some((m) => m._omitted));
});

test("a small body is stored unchanged", () => {
  const body = { model: "m", messages: [{ role: "user", content: "hi" }] };
  const { value, truncated } = compactBody(body);
  assert.deepEqual(value, body);
  assert.equal(truncated, false);
});

test("describeBody reports size, turns, stream flag and the last user text", () => {
  const d = describeBody({ model: "m", stream: true, messages: [
    { role: "user", content: "first" }, { role: "assistant", content: "ok" }, { role: "user", content: [{ type: "text", text: `last  ${KEY}` }] },
  ] });
  assert.equal(d.messageCount, 3);
  assert.equal(d.stream, true);
  assert.ok(d.bodyBytes > 50 && d.estTokens === Math.round(d.bodyBytes / 4));
  assert.equal(d.preview, "last Bearer-free sk-[redacted]".replace("Bearer-free ", ""));
});

// ── classification ─────────────────────────────────────────────────────────

test("source follows what the router did before the failure", () => {
  assert.equal(classifySource({ attempts: [{}], status: 503 }), "upstream");
  for (const s of [401, 402, 403, 429]) assert.equal(classifySource({ attempts: [], status: s }), "platform");
  assert.equal(classifySource({ attempts: [], status: 400 }), "request");
  assert.equal(classifySource({ attempts: [], status: 404 }), "request");
  assert.equal(classifySource({ attempts: [], status: 503 }), "router");
  assert.equal(classifySource({ attempts: [], status: 500 }), "router");
});

// ── the trace ──────────────────────────────────────────────────────────────

test("the trace keeps the raw client text and the model, and a text snapshot of each failed upstream body", async () => {
  const trace = createTrace("/v1/chat/completions");
  const upstream = { model: "up", messages: [{ role: "user", content: "before" }] };
  let snapshot;
  await runWithTrace(trace, async () => {
    const raw = JSON.stringify({ model: "combo", messages: [{ role: "user", content: "hi" }] });
    noteClientBody(JSON.parse(raw), raw);
    noteClientBody({ model: "ignored" }, "{}"); // first one wins
    noteUpstreamBody(upstream);
    upstream.messages[0].content = "after"; // a later attempt rewrites the shared objects
    noteAttempt({ provider: "p", model: "up", connectionId: "c1", status: 400, error: "bad" });
    snapshot = JSON.parse(getTrace().attempts[0].upstreamBodyText);
    noteAttempt({ provider: "p", model: "up", connectionId: "c2", status: 502, error: "down" }); // no body pending
    assert.equal(getTrace(), trace);
  });
  assert.equal(trace.requestedModel, "combo");
  assert.equal(JSON.parse(trace.clientBodyText).messages[0].content, "hi");
  assert.equal(trace.attempts.length, 2);
  assert.equal(snapshot.messages[0].content, "before", "the snapshot is not the live object");
  assert.equal(trace.attempts[1].upstreamBodyText, null);
  assert.equal(trace.attempts[0].upstreamBodyText, null, "only the latest attempt keeps its body text");
  assert.equal(getTrace(), null);
  noteClientBody({}, "{}"); // outside a trace: a no-op, not an error
});

// ── recording ──────────────────────────────────────────────────────────────

function failedTrace(clientBody = { model: "GLM-5.3", stream: true, messages: [{ role: "system", content: "s" }, { role: "user", content: "hello there" }] }) {
  const trace = createTrace("/v1/chat/completions");
  trace.clientBodyText = JSON.stringify(clientBody);
  trace.requestedModel = clientBody.model ?? null;
  trace.attempts.push({
    at: trace.startedAt + 40, provider: "openai-compatible-chat-x", model: "glm-5.3:pre", connectionId: "conn-1", connectionName: "Vin",
    status: 400, error: `[400]: {"details":{"type":"context_length"}} Bearer ${KEY}`,
    upstreamBodyText: JSON.stringify({ model: "glm-5.3:pre", messages: [{ role: "user", content: "hello there" }] }),
  });
  return trace;
}

test("an upstream failure keeps the error, the request, the upstream request and every attempt", async () => {
  const id = await recordErrorLog({
    trace: failedTrace(), endpoint: "/v1/chat/completions", status: 400,
    responseText: JSON.stringify({ error: { message: "context too long", code: "context_length" } }),
    key: { apiKeyId: "key-1", owner: "ann@example.com" }, userAgent: "curl/8",
  });
  const row = await repo.getErrorLog(id);
  assert.equal(row.source, "upstream");
  assert.equal(row.status, 400);
  assert.equal(row.requestedModel, "GLM-5.3");
  assert.equal(row.provider, "openai-compatible-chat-x");
  assert.equal(row.model, "glm-5.3:pre");
  assert.equal(row.connectionName, "Vin");
  assert.equal(row.apiKeyId, "key-1");
  assert.equal(row.owner, "ann@example.com");
  assert.equal(row.errorCode, "context_length");
  assert.equal(row.message, "context too long");
  assert.equal(row.stream, true);
  assert.equal(row.messageCount, 2);
  assert.ok(row.bodyBytes > 0);
  assert.equal(row.data.promptStored, true);
  assert.equal(row.data.request.messages[1].content, "hello there");
  assert.equal(row.data.upstreamRequest.model, "glm-5.3:pre");
  assert.equal(row.data.attempts.length, 1);
  assert.equal(row.data.attempts[0].status, 400);
  assert.equal(row.data.attempts[0].afterMs, 40);
  assert.ok(!JSON.stringify(row).includes("6920ba17"), "no key text may reach the table");
});

test("a platform denial keeps the facts but not the prompt", async () => {
  const trace = createTrace("/v1/chat/completions");
  trace.clientBodyText = JSON.stringify({ model: "m", messages: [{ role: "user", content: "secret customer text" }] });
  trace.requestedModel = "m";
  const id = await recordErrorLog({
    trace, status: 429,
    responseText: JSON.stringify({ error: { message: "Vượt giới hạn RPM", type: "rate_limit_error", code: "rate_limit" } }),
    key: { apiKeyId: "key-1", owner: "ann@example.com" },
  });
  const row = await repo.getErrorLog(id);
  assert.equal(row.source, "platform");
  assert.equal(row.errorCode, "rate_limit");
  assert.equal(row.data.promptStored, false);
  assert.equal(row.data.request, null);
  assert.ok(row.bodyBytes > 0 && row.messageCount === 1, "size facts are still kept");
  assert.ok(!JSON.stringify(row).includes("secret customer text"));
});

test("an unauthenticated 401 and client aborts are not logged, but a 401 an upstream returned is", async () => {
  const bare = () => createTrace("/v1/chat/completions");
  assert.equal(await recordErrorLog({ trace: bare(), status: 401, responseText: "{}" }), null);
  assert.equal(await recordErrorLog({ trace: failedTrace(), status: 499, responseText: "{}" }), null);
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM errorLogs`).n, 0);

  const id = await recordErrorLog({ trace: failedTrace(), status: 401, responseText: '{"error":{"message":"provider credential expired"}}' });
  assert.equal((await repo.getErrorLog(id)).source, "upstream");
});

test("the costly parts only run for an entry that is kept", async () => {
  let ran = 0;
  const lazyInputs = { requestBody: async () => { ran++; return { model: "m" }; }, key: async () => { ran++; return null; } };
  assert.equal(await recordErrorLog({ trace: createTrace(""), status: 401, responseText: "{}", ...lazyInputs }), null);
  await repo.setErrorLogConfig({ enabled: false });
  assert.equal(await recordErrorLog({ trace: createTrace(""), status: 400, responseText: "{}", ...lazyInputs }), null);
  assert.equal(ran, 0, "skipped and disabled requests cost no body read and no key lookup");
  await repo.setErrorLogConfig({ enabled: true });
  assert.ok(await recordErrorLog({ trace: createTrace(""), status: 400, responseText: "{}", ...lazyInputs }));
  assert.equal(ran, 2);
});

test("with prompt storage off only the facts are kept", async () => {
  await repo.setErrorLogConfig({ storePrompt: false });
  const id = await recordErrorLog({ trace: failedTrace(), status: 400, responseText: '{"error":{"message":"x"}}' });
  const row = await repo.getErrorLog(id);
  assert.equal(row.data.promptStored, false);
  assert.equal(row.data.request, null);
  assert.equal(row.data.upstreamRequest, null);
  assert.equal(row.data.preview, "", "the preview is prompt text and is dropped too");
  assert.equal(row.messageCount, 2);
  assert.equal(row.requestedModel, "GLM-5.3");
  assert.equal(row.data.attempts.length, 1);
});

test("with the log switched off nothing is written", async () => {
  await repo.setErrorLogConfig({ enabled: false });
  assert.equal(await recordErrorLog({ trace: failedTrace(), status: 400, responseText: "{}" }), null);
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM errorLogs`).n, 0);
});

test("a stream that fails after the headers is logged with source stream", async () => {
  const id = await recordErrorLog({
    trace: failedTrace(), source: "stream", status: 200, message: "stream stall timeout",
    streamInfo: { chunks: 12, bytes: 4096 },
  });
  const row = await repo.getErrorLog(id);
  assert.equal(row.source, "stream");
  assert.equal(row.status, 200);
  assert.equal(row.message, "stream stall timeout");
  assert.equal(row.data.stream.chunks, 12);
});

test("a failure of the log itself never reaches the caller", async () => {
  const id = await recordErrorLog({ trace: failedTrace(), status: 400, responseText: "{}" }, {
    getConfig: async () => ({ enabled: true, storePrompt: true, maxBodyKB: 64, retentionDays: 14, maxRows: 10 }),
    insert: async () => { throw new Error("disk full"); },
  });
  assert.equal(id, null);
});

// ── listing, filters, retention ────────────────────────────────────────────

async function seed(n, over = {}) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    ids.push(await repo.insertErrorLog({
      timestamp: new Date(Date.UTC(2026, 9, 30, 10, 0, i)).toISOString(),
      source: "upstream", status: 400 + (i % 2) * 113, requestedModel: i % 3 ? "GLM-5.3" : "DeepSeek",
      message: `failure ${i}`, owner: "ann@example.com", data: { big: "x".repeat(1000) }, ...over,
    }));
  }
  return ids;
}

test("the list is newest first, filtered and paged without loading the prompt blobs", async () => {
  await seed(7);
  const first = await repo.listErrorLogs({ limit: 3 });
  assert.deepEqual(first.items.map((r) => r.message), ["failure 6", "failure 5", "failure 4"]);
  assert.ok(first.nextBefore);
  assert.equal(first.items[0].data, undefined, "the list never carries the data blob");
  const second = await repo.listErrorLogs({ limit: 3, before: first.nextBefore });
  assert.deepEqual(second.items.map((r) => r.message), ["failure 3", "failure 2", "failure 1"]);
  const third = await repo.listErrorLogs({ limit: 3, before: second.nextBefore });
  assert.deepEqual(third.items.map((r) => r.message), ["failure 0"]);
  assert.equal(third.nextBefore, null);

  assert.equal((await repo.listErrorLogs({ status: "5" })).items.length, 3);   // 513 x3 (i odd)
  assert.equal((await repo.listErrorLogs({ status: "400" })).items.length, 4);
  assert.equal((await repo.listErrorLogs({ model: "deepseek" })).items.length, 3);
  assert.equal((await repo.listErrorLogs({ q: "failure 5" })).items.length, 1);
  assert.equal((await repo.listErrorLogs({ q: "100%_" })).items.length, 0, "LIKE wildcards are escaped");
});

test("pruning drops rows past the age and then the oldest past the cap", async () => {
  const old = new Date(Date.now() - 20 * 86_400_000).toISOString();
  await repo.insertErrorLog({ timestamp: old, source: "upstream", status: 400, message: "ancient", data: {} });
  await seed(5, { timestamp: undefined });
  const removed = await repo.pruneErrorLogs({ retentionDays: 14, maxRows: 3 });
  assert.equal(removed, 3); // 1 by age, then 2 by cap
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM errorLogs`).n, 3);
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM errorLogs WHERE message = 'ancient'`).n, 0);
});

test("recording prunes on its own once the cap is exceeded", async () => {
  await repo.setErrorLogConfig({ maxRows: 100 });
  for (let i = 0; i < 130; i++) {
    await recordErrorLog({ trace: failedTrace(), status: 400, responseText: `{"error":{"message":"e${i}"}}` });
  }
  const n = db.get(`SELECT COUNT(*) AS n FROM errorLogs`).n;
  assert.ok(n <= 100 + 25, `the log stayed bounded (${n})`);
});

test("clearing removes everything, or only what is older than the given days", async () => {
  await repo.insertErrorLog({ timestamp: new Date(Date.now() - 10 * 86_400_000).toISOString(), source: "router", status: 503, message: "old", data: {} });
  await repo.insertErrorLog({ source: "router", status: 503, message: "new", data: {} });
  assert.equal(await repo.clearErrorLogs({ olderThanDays: 7 }), 1);
  assert.equal(db.get(`SELECT message FROM errorLogs`).message, "new");
  assert.equal(await repo.clearErrorLogs(), 1);
});

test("the summary counts per source", async () => {
  await seed(2, { source: "upstream" });
  await seed(1, { source: "platform" });
  const s = await repo.errorLogSummary(new Date(0));
  assert.equal(s.total, 3);
  assert.deepEqual(s.bySource, { upstream: 2, platform: 1, request: 0, router: 0, stream: 0 });
});

test("config values are clamped to their limits and unknown fields are ignored", async () => {
  const c = await repo.setErrorLogConfig({ retentionDays: 99999, maxRows: 1, maxBodyKB: 5000, bogus: 1 });
  assert.equal(c.retentionDays, 365);
  assert.equal(c.maxRows, 100);
  assert.equal(c.maxBodyKB, 1024);
  assert.equal(c.bogus, undefined);
});

// ── the client's request, not the router's rewrite ─────────────────────────

test("the stored client request and model survive the engine rewriting the parsed body", async () => {
  const raw = JSON.stringify({ model: "GLM-5.3", messages: [{ role: "developer", content: "be brief" }, { role: "user", content: "original question" }] });
  const trace = createTrace("/v1/chat/completions");
  const parsed = JSON.parse(raw);
  await runWithTrace(trace, async () => { noteClientBody(parsed, raw); });
  // what the translator and token-saver steps do to the shared parsed object
  parsed.model = "glm-5.3:pre";
  parsed.messages[0].role = "system";
  parsed.messages[1].content = "[compressed] q";
  parsed.messages.push({ role: "system", content: "injected prompt" });
  trace.attempts.push({ at: Date.now(), provider: "p", model: "glm-5.3:pre", status: 400, error: "e", upstreamBodyText: JSON.stringify(parsed) });

  const id = await recordErrorLog({ trace, status: 400, responseText: '{"error":{"message":"x"}}' });
  const row = await repo.getErrorLog(id);
  assert.equal(row.requestedModel, "GLM-5.3");
  assert.equal(row.messageCount, 2);
  assert.equal(row.bodyBytes, Buffer.byteLength(raw));
  assert.equal(row.data.request.messages[0].role, "developer");
  assert.equal(row.data.request.messages[1].content, "original question");
  assert.equal(row.data.upstreamRequest.messages.length, 3, "the upstream body is the rewritten one");
  assert.equal(row.data.upstreamRequest.model, "glm-5.3:pre");
});

// ── masking and compaction limits ──────────────────────────────────────────

test("vendor key shapes and more credential field names are masked", () => {
  const googleKey = `AIza${"Sy".repeat(18)}`;
  assert.ok(!maskSecrets(`x-goog-api-key: ${googleKey}`).includes("AIza"));
  assert.ok(!maskSecrets(`token ya29.${"a1".repeat(20)}`).includes("ya29"));
  assert.ok(!maskSecrets(`gsk_${"abc123".repeat(5)}`).includes("gsk_"));
  assert.ok(!maskSecrets("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U").includes("eyJhbGci"));
  const { value } = compactBody({ client_secret: "s3cr3t", "x-goog-api-key": "abc", auth_token: "t", model: "m" });
  assert.deepEqual([value.client_secret, value["x-goog-api-key"], value.auth_token, value.model], ["[redacted]", "[redacted]", "[redacted]", "m"]);
});

test("a secret just inside a cut string is masked, and a huge string is cut before it is scanned", () => {
  const big = `${"x".repeat(5000)} Bearer ${KEY} ${"y".repeat(5_000_000)}`;
  const { value } = compactBody({ model: "m", messages: [{ role: "user", content: big }] }, { maxBytes: 64 * 1024 });
  const text = JSON.stringify(value);
  assert.ok(!text.includes("6920ba17"));
  assert.match(text, /chars cut/);
});

test("a body that cannot fit even after compaction keeps only its facts", () => {
  const body = { model: "m", stream: true, logit_bias: Array.from({ length: 50_000 }, (_, i) => i) };
  const { value, truncated } = compactBody(body, { maxBytes: 8 * 1024 });
  assert.equal(truncated, true);
  assert.match(value._omitted, /does not fit/);
  assert.equal(value.model, "m");
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < 8 * 1024);
});

test("a body past the walk limit is described, not scanned", () => {
  const body = { model: "m", messages: [{ role: "user", content: "z".repeat(9 * 1024 * 1024) }] };
  const { value, truncated, originalBytes } = compactBody(body);
  assert.equal(truncated, true);
  assert.match(value._omitted, /too large/);
  assert.ok(originalBytes > 9 * 1024 * 1024);
});

// ── the wrapper ────────────────────────────────────────────────────────────

const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const postReq = (body, headers = {}) => new Request("http://x/v1/chat/completions", {
  method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "test-agent", ...headers }, body: JSON.stringify(body),
});
const settle = () => new Promise((r) => setTimeout(r, 60));
const rows = () => db.all(`SELECT * FROM errorLogs ORDER BY timestamp`);
const withLog = createWithErrorLog({ resolveKey: async () => ({ apiKeyId: "k1", owner: "ann@example.com" }) });

test("wrapper: a failed response is returned untouched and recorded afterwards with the cloned body", async () => {
  const handler = withLog(async (request) => {
    await request.json(); // the handler consumes the body
    return jsonRes(400, { error: { message: "nope", code: "bad_request" } });
  }, { cloneBody: true });
  const res = await handler(postReq({ model: "m", input: "embed me" }));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: { message: "nope", code: "bad_request" } }, "the caller still reads the full body");
  await settle();
  const [row] = rows();
  assert.equal(row.source, "request");
  assert.equal(row.errorCode, "bad_request");
  assert.equal(row.owner, "ann@example.com");
  assert.equal(JSON.parse(row.data).request.input, "embed me");
  assert.equal(JSON.parse(row.data).userAgent, "test-agent");
});

test("wrapper: successes and unauthenticated 401s are not recorded", async () => {
  const ok = withLog(async () => jsonRes(200, { ok: true }));
  const denied = withLog(async () => jsonRes(401, { error: "API key required" }));
  assert.equal((await ok(postReq({}))).status, 200);
  assert.equal((await denied(postReq({}))).status, 401);
  await settle();
  assert.equal(rows().length, 0);
});

test("wrapper: a handler that throws is recorded as a router failure and the error still propagates", async () => {
  const handler = withLog(async () => { throw new Error("boom"); });
  await assert.rejects(handler(postReq({ model: "m" })), /boom/);
  await settle();
  const [row] = rows();
  assert.equal(row.source, "router");
  assert.equal(row.status, 500);
  assert.equal(row.message, "boom");
});

test("wrapper: engine notes made inside the handler end up in the entry", async () => {
  const handler = withLog(async () => {
    const raw = JSON.stringify({ model: "GLM-5.3", messages: [{ role: "user", content: "asked" }] });
    noteClientBody(JSON.parse(raw), raw);
    noteUpstreamBody({ model: "glm-5.3:pre", messages: [{ role: "user", content: "asked" }] });
    noteAttempt({ provider: "p", model: "glm-5.3:pre", connectionId: "c1", connectionName: "Vin", status: 400, error: "[400]: context_length" });
    return jsonRes(400, { error: { message: "[p/glm-5.3:pre] [400]: context_length" } });
  });
  await handler(postReq({}));
  await settle();
  const [row] = rows();
  assert.equal(row.source, "upstream");
  assert.equal(row.requestedModel, "GLM-5.3");
  assert.equal(row.connectionName, "Vin");
  assert.equal(row.message, "[400]: context_length", "the provider tag is stripped from the message");
  assert.equal(JSON.parse(row.data).upstreamRequest.model, "glm-5.3:pre");
});

test("wrapper: a stream that dies after its headers is recorded with how far it got", async () => {
  let trace;
  const handler = withLog(async () => {
    const { getTrace: current } = await import("../open-sse/utils/errorTrace.js");
    trace = current();
    const raw = JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "go" }] });
    noteClientBody(JSON.parse(raw), raw);
    return new Response("data: x\n\n", { status: 200 });
  });
  const res = await handler(postReq({}));
  assert.equal(res.status, 200);
  // later, when the stream breaks, chatCore reports it through the trace it captured
  trace.onStreamError({ message: "stream stall timeout", provider: "p", model: "m", connectionId: "c", chunks: 12, bytes: 4096, upstreamText: '{"model":"m"}' });
  await settle();
  const [row] = rows();
  assert.equal(row.source, "stream");
  assert.equal(row.status, 200);
  assert.equal(row.message, "Stream failed: stream stall timeout");
  assert.deepEqual(JSON.parse(row.data).stream, { chunks: 12, bytes: 4096 });
  assert.equal(JSON.parse(row.data).upstreamRequest.model, "m");
});

test("wrapper: a recorder that fails does not touch the response", async () => {
  const broken = createWithErrorLog({ resolveKey: async () => { throw new Error("db down"); }, record: async () => { throw new Error("db down"); } });
  const res = await broken(async () => jsonRes(503, { error: { message: "x" } }))(postReq({}));
  assert.equal(res.status, 503);
  await settle(); // an unhandled rejection here would fail the run
});

test("a request too large to keep as text is described by its size only", async () => {
  const trace = createTrace("/v1/chat/completions");
  const raw = JSON.stringify({ model: "m", messages: [{ role: "user", content: "q".repeat(9 * 1024 * 1024) }] });
  await runWithTrace(trace, async () => { noteClientBody(JSON.parse(raw), raw); });
  assert.equal(trace.clientBodyText, null);
  assert.equal(trace.clientBodyBytes, Buffer.byteLength(raw));
  assert.equal(trace.requestedModel, "m");
  const id = await recordErrorLog({ trace, status: 400, responseText: '{"error":{"message":"too big"}}' });
  const row = await repo.getErrorLog(id);
  assert.equal(row.bodyBytes, Buffer.byteLength(raw));
  assert.equal(row.requestedModel, "m");
  assert.equal(row.data.request, null);
});
