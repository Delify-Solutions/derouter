// Customer leak fixes (change customer-leak-fixes, spec model-privacy): what a
// customer key could still learn about the upstream behind a combo.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-customer-leaks-"));
process.env.DATA_DIR = tmpDir;
// A small document cap so the fail-closed path is testable (read at import).
process.env.STREAM_MAX_BUFFER_BYTES = String(64 * 1024);


const { getAdapter } = await import("../src/lib/db/driver.js");
const pm = await import("../src/lib/models/publicModel.js");
const cm = await import("../src/lib/models/customerModels.js");
const { createApiKey } = await import("../src/lib/db/repos/apiKeysRepo.js");
const { __test__: detailsRepo } = await import("../src/lib/db/repos/requestDetailsRepo.js");
const details = await import("../src/lib/usage/publicRequestDetails.js");
const { extractApiKey } = await import("../src/lib/auth/apiKeyExtract.js");
const { refuseCustomerEndpointSync, refuseUnmeteredSync, CUSTOMER_CLOSED_ENDPOINT_MESSAGE } = await import("../src/lib/auth/unmeteredEndpoints.js");
const { publicLoginSettings } = await import("../src/lib/auth/publicSettings.js");
const { geminiComboModels, geminiCatalogModels } = await import("../src/lib/models/geminiModelList.js");
const sealed = await import("../src/lib/crypto/sealedIds.js");

let db;
let customerKey;
let adminKey;
before(async () => {
  db = await getAdapter();
  const now = new Date().toISOString();
  db.run(`INSERT INTO users(id, email, passwordHash, status, createdAt) VALUES('u1', 'u1@t.io', 'x', 'active', ?)`, [now]);
  db.run(`INSERT INTO combos(id, name, models, createdAt, updatedAt) VALUES('c1', 'glm-5', ?, ?, ?)`, [JSON.stringify(["zai/glm-5.3:pre"]), now, now]);
  customerKey = (await createApiKey("cust", "m", { userId: "u1" })).key;
  adminKey = (await createApiKey("ops", "m")).key;
});
after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const OPTS = {
  publicName: "glm-5",
  ids: pm.hiddenModelIds({ members: ["zai/glm-5.3:pre"], upstream: ["glm-5.3:pre"], publicName: "glm-5" }),
  providers: pm.hiddenProviderIds({ members: ["zai/glm-5.3:pre"], publicName: "glm-5" }),
};

const sseResponse = (text, init = {}) => new Response(text, { status: 200, ...init, headers: { "content-type": "text/event-stream", ...(init.headers || {}) } });

function chunkedStream(text, size) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < text.length; i += size) controller.enqueue(enc.encode(text.slice(i, i + size)));
      controller.close();
    },
  });
}

// ── 1. Request details ──────────────────────────────────────────────────────

test("new request-detail ids carry no model", () => {
  const id = detailsRepo.generateDetailId();
  assert.match(id, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z-[a-z0-9]{12}$/);
  assert.notEqual(detailsRepo.generateDetailId(), id, "unique");
});

test("a customer's request details carry no connection id and no upstream model in any id", () => {
  const stored = {
    id: "2026-11-01T10:00:00.000Z-ab12cd-glm-5-3-pre",
    connectionId: "conn-9f2c",
    provider: "zai",
    model: "glm-5.3:pre",
    requestedModel: "glm-5",
    timestamp: "2026-11-01T10:00:00.000Z",
    status: "success",
    tokens: { prompt_tokens: 3, completion_tokens: 1 },
    request: { model: "glm-5.3:pre", messages: [{ role: "user", content: "hi" }] },
    response: { content: "ok" },
  };
  const row = details.scrubDetailForList(stored, true, true);
  assert.equal("connectionId" in row, false);
  assert.equal("resolvedModel" in row, false);
  assert.equal(typeof row.id, "string");
  assert.notEqual(row.id, stored.id);
  assert.doesNotMatch(JSON.stringify(row), /glm-5\.3|glm-5-3|conn-9f2c|zai/);

  // The opaque id is stable and resolves back to the row; the connection id and
  // the stored id do not resolve for a customer.
  assert.equal(details.scrubDetail(stored, false, true).id, row.id);
  assert.equal(details.findDetail([stored], row.id, true), stored);
  assert.equal(details.findDetail([stored], "conn-9f2c", true), null);
  assert.equal(details.findDetail([stored], stored.id, true), null);
  assert.equal(details.findDetail([stored], "2026-11-01T10:00:30.000Z", true), stored, "timestamp link from the history");

  // An admin key keeps the connection id and the resolved model.
  const admin = details.scrubDetailForList(stored, false, false);
  assert.equal(admin.connectionId, "conn-9f2c");
  assert.equal(admin.resolvedModel, "glm-5.3:pre");
  assert.equal(details.findDetail([stored], "conn-9f2c", false), stored);
});

// ── 2. JSON document under SSE headers ──────────────────────────────────────

test("a JSON document answering a stream is masked as a document", async () => {
  const doc = JSON.stringify({ id: "gen-1", object: "chat.completion", model: "glm-5.3:pre", provider: "zai", choices: [{ index: 0, message: { role: "assistant", content: "glm-5.3:pre here" }, native_finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost: 0.0004 } });
  const out = await (await pm.maskResponse(new Response(chunkedStream(`\n${doc}`, 7), { headers: { "content-type": "text/event-stream" } }), OPTS)).text();
  const body = JSON.parse(out);
  assert.equal(body.model, "glm-5");
  assert.equal(body.provider, undefined);
  assert.equal(body.usage.cost, undefined);
  assert.equal(body.choices[0].native_finish_reason, undefined);
  assert.equal(body.choices[0].message.content, "glm-5.3:pre here", "content is never touched");
  assert.match(body.id, /^chatcmpl-/);

  // An error status is rebuilt like a JSON error.
  const err = await (await pm.maskResponse(sseResponse(JSON.stringify({ error: { message: "Incorrect API key provided for zai", code: "invalid_api_key" } }), { status: 401 }), OPTS)).json();
  assert.equal(err.error.code, "model_unavailable");
  assert.doesNotMatch(JSON.stringify(err), /zai|invalid_api_key/);

  // A top-level array (Gemini streamGenerateContent without alt=sse).
  const arr = JSON.parse(await (await pm.maskResponse(sseResponse(JSON.stringify([{ modelVersion: "glm-5.3:pre", usageMetadata: { promptTokenCount: 1, trafficType: "ON_DEMAND" } }])), OPTS)).text());
  assert.equal(arr[0].modelVersion, "glm-5");
  assert.equal(arr[0].usageMetadata.trafficType, undefined);

  // JSON lines.
  const lines = await (await pm.maskResponse(sseResponse('{"model":"glm-5.3:pre"}\n{"model":"glm-5.3:pre","provider":"zai"}\n'), OPTS)).text();
  assert.doesNotMatch(lines, /glm-5\.3|zai/);

  // Past the cap the mask fails closed instead of forwarding raw bytes.
  const big = JSON.stringify({ model: "glm-5.3:pre", choices: [{ message: { content: "x".repeat(70 * 1024) } }] });
  const closed = JSON.parse(await (await pm.maskResponse(sseResponse(big), OPTS)).text());
  assert.equal(closed.error.code, "model_error");

  // An ordinary SSE stream is still streamed line by line.
  const sse = await (await pm.maskResponse(sseResponse('data: {"model":"glm-5.3:pre"}\n\ndata: [DONE]\n\n'), OPTS)).text();
  assert.equal(sse, 'data: {"model":"glm-5"}\n\ndata: [DONE]\n\n');
});

// ── 3. Gemini native TTS ────────────────────────────────────────────────────

// The route itself is exercised in customer-leak-routes.test.js.
test("the customer-endpoint denial: customer refused, admin and keyless kept", () => {
  const denial = refuseCustomerEndpointSync(db, customerKey);
  assert.deepEqual(denial, { status: 403, code: "endpoint_not_available", message: CUSTOMER_CLOSED_ENDPOINT_MESSAGE });
  assert.equal(refuseCustomerEndpointSync(db, adminKey), null, "admin key keeps the path");
  assert.equal(refuseCustomerEndpointSync(db, null), null, "keyless local use keeps the path");
  assert.equal(refuseUnmeteredSync(db, customerKey).code, "endpoint_not_available", "unmetered endpoints unchanged");
});

// ── 4. One key extractor ────────────────────────────────────────────────────

// That the guard and the handlers use this very function is checked in
// customer-leak-routes.test.js.
test("the shared key extractor: Bearer, x-api-key, x-goog-api-key, ?key=", () => {
  const req = (headers = {}, url = "http://x/v1/chat/completions") => new Request(url, { headers });
  assert.equal(extractApiKey(req({ authorization: "Bearer a", "x-api-key": "b", "x-goog-api-key": "c" }, "http://x/v1?key=d")), "a");
  assert.equal(extractApiKey(req({ "x-api-key": "b", "x-goog-api-key": "c" }, "http://x/v1?key=d")), "b");
  assert.equal(extractApiKey(req({ "x-goog-api-key": "c" }, "http://x/v1?key=d")), "c");
  assert.equal(extractApiKey(req({}, "http://x/v1beta/models/glm-5:generateContent?key=d")), "d");
  assert.equal(extractApiKey(req({})), null);
  // NextRequest exposes nextUrl; the same key is read from it.
  assert.equal(extractApiKey({ headers: new Headers(), nextUrl: new URL("http://x/v1?key=e"), url: "http://x/v1" }), "e");
});

// ── 5. Provider-identifying fields, usage, ids ──────────────────────────────

test("a customer's JSON bodies lose provider fields and usage extras; content and tool ids stay", () => {
  const chat = pm.maskModelFields({
    id: "gen-abc", object: "chat.completion", model: "glm-5.3:pre", provider: "Fireworks", system_fingerprint: "fp_1", service_tier: "default",
    choices: [{ index: 0, native_finish_reason: "end_turn", finish_reason: "stop", message: { role: "assistant", content: "hello", tool_calls: [{ id: "call_zai_1", type: "function", function: { name: "f", arguments: "{}" } }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: 0.01, is_byok: false, cost_details: { upstream_inference_cost: 1 }, prompt_cache_hit_tokens: 6, prompt_cache_miss_tokens: 4, prompt_tokens_details: { cached_tokens: 6, cache_write_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 } },
  }, OPTS);
  assert.match(chat.id, /^chatcmpl-[0-9a-f]{32}$/);
  for (const field of ["provider", "system_fingerprint"]) assert.equal(chat[field], undefined, field);
  assert.equal(chat.service_tier, "default", "standard OpenAI field kept");
  assert.equal(chat.choices[0].native_finish_reason, undefined);
  assert.equal(chat.choices[0].finish_reason, "stop");
  assert.equal(chat.choices[0].message.tool_calls[0].id, "call_zai_1", "tool-call ids are never touched");
  assert.deepEqual(chat.usage, { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 6 }, completion_tokens_details: { reasoning_tokens: 1 } });

  const claude = pm.maskModelFields({ id: "msg_bdrk_01", type: "message", role: "assistant", model: "glm-5.3:pre", content: [{ type: "tool_use", id: "toolu_bdrk_9", name: "f", input: {} }], usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 2, service_tier: "standard", inference_geo: "us" } }, OPTS);
  assert.match(claude.id, /^msg_[0-9a-f]{32}$/);
  assert.equal(claude.content[0].id, "toolu_bdrk_9");
  assert.deepEqual(claude.usage, { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 2 });

  const responses = pm.maskModelFields({ id: "resp_123", object: "response", model: "glm-5.3:pre", output: [{ type: "message", id: "msg_item_1", content: [] }], usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7, cost: 1, input_tokens_details: { cached_tokens: 1 } } }, OPTS);
  assert.equal(responses.id, "resp_123", "Responses ids are chained by clients and kept");
  assert.equal(responses.output[0].id, "msg_item_1");
  assert.deepEqual(responses.usage, { input_tokens: 5, output_tokens: 2, total_tokens: 7, input_tokens_details: { cached_tokens: 1 } });

  const gemini = pm.maskModelFields({ response: { responseId: "gen-77", modelVersion: "glm-5.3:pre", usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3, trafficType: "ON_DEMAND" } } }, OPTS);
  assert.equal(gemini.response.modelVersion, "glm-5");
  assert.notEqual(gemini.response.responseId, "gen-77");
  assert.deepEqual(gemini.response.usageMetadata, { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 });

  const groq = pm.maskModelFields({ id: "chatcmpl-x", object: "chat.completion.chunk", choices: [], x_groq: { id: "req_1", usage: { queue_time: 1 } } }, OPTS);
  assert.equal(groq.x_groq, undefined);
});

test("every event of one customer stream carries the same router id", async () => {
  const events = [
    'data: {"id":"gen-1","object":"chat.completion.chunk","model":"glm-5.3:pre","system_fingerprint":"fp","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_up_1","function":{"name":"f","arguments":""}}]}}]}',
    'data: {"id":"gen-2","object":"chat.completion.chunk","model":"glm-5.3:pre","choices":[{"index":0,"delta":{"content":"hi"},"native_finish_reason":null}]}',
    'data: {"id":"gen-1","object":"chat.completion.chunk","model":"glm-5.3:pre","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2,"cost":0.5}}',
    "data: [DONE]",
  ].join("\n\n") + "\n\n";
  const out = await new Response(chunkedStream(events, 13).pipeThrough(pm.createSseMaskStream(OPTS))).text();
  const chunks = out.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
  assert.equal(chunks.length, 3);
  const ids = new Set(chunks.map((c) => c.id));
  assert.equal(ids.size, 1);
  assert.match([...ids][0], /^chatcmpl-/);
  assert.equal(chunks[0].choices[0].delta.tool_calls[0].id, "call_up_1");
  assert.equal(chunks[0].system_fingerprint, undefined);
  assert.equal("native_finish_reason" in chunks[1].choices[0], false);
  assert.deepEqual(chunks[2].usage, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
  assert.match(out, /data: \[DONE\]\n\n$/);

  const claude = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_vrtx_1","type":"message","model":"glm-5.3:pre","usage":{"input_tokens":3,"output_tokens":0,"service_tier":"standard"}}}',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4,"cost":1}}',
  ].join("\n\n") + "\n\n";
  const claudeOut = await (await pm.maskResponse(sseResponse(claude), OPTS)).text();
  const start = JSON.parse(claudeOut.split("\n").find((l) => l.includes("message_start") && l.startsWith("data:")).slice(6));
  assert.match(start.message.id, /^msg_[0-9a-f]{32}$/);
  assert.deepEqual(start.message.usage, { input_tokens: 3, output_tokens: 0 });
  assert.doesNotMatch(claudeOut, /vrtx|"cost"/);
});

test("an admin key gets no mask at all", () => {
  assert.equal(cm.publicModelContextSync(db, {}, { apiKey: adminKey, publicName: "glm-5" }), null);
  assert.notEqual(cm.publicModelContextSync(db, {}, { apiKey: customerKey, publicName: "glm-5" }), null);
});

// ── 6-8. Catalogs and settings ──────────────────────────────────────────────

test("the router's own usage fields survive the allow-list (cache writes are billed)", () => {
  // buildUsage (Claude, Kiro, Command Code, Qoder upstreams) reports cache writes here.
  const chat = pm.maskModelFields({ object: "chat.completion", choices: [], usage: { prompt_tokens: 4511, completion_tokens: 20, total_tokens: 4531, prompt_tokens_details: { cached_tokens: 4000, cache_creation_tokens: 480 }, completion_tokens_details: { reasoning_tokens: 8 } } }, OPTS);
  assert.deepEqual(chat.usage, { prompt_tokens: 4511, completion_tokens: 20, total_tokens: 4531, prompt_tokens_details: { cached_tokens: 4000, cache_creation_tokens: 480 }, completion_tokens_details: { reasoning_tokens: 8 } });
  // The router's compat whitelist may emit cached/reasoning at the top.
  assert.deepEqual(pm.maskModelFields({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cached_tokens: 1, reasoning_tokens: 1 } }, OPTS).usage, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cached_tokens: 1, reasoning_tokens: 1 });
  // Claude usage as openai-to-claude builds it.
  assert.deepEqual(pm.maskModelFields({ type: "message_delta", delta: {}, usage: { input_tokens: 31, output_tokens: 2, cache_read_input_tokens: 4000, cache_creation_input_tokens: 480 } }, OPTS).usage, { input_tokens: 31, output_tokens: 2, cache_read_input_tokens: 4000, cache_creation_input_tokens: 480 });
  // Gemini usage as geminiUsageFromOpenAI builds it.
  const gem = { promptTokenCount: 4511, candidatesTokenCount: 12, totalTokenCount: 4531, thoughtsTokenCount: 8, cachedContentTokenCount: 4000 };
  assert.deepEqual(pm.maskModelFields({ candidates: [], usageMetadata: { ...gem } }, OPTS).usageMetadata, gem);
});

test("image and embedding bodies keep only standard usage and lose provider fields", () => {
  const image = pm.maskModelFields({ created: 1, model: "gpt-image-x", provider: "OpenRouter", data: [{ b64_json: "AAAA" }], usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30, input_tokens_details: { text_tokens: 8, image_tokens: 2, cache: 1 }, cost: 0.04, is_byok: false } }, OPTS);
  assert.equal(image.provider, undefined);
  assert.equal(image.data[0].b64_json, "AAAA", "content untouched");
  assert.deepEqual(image.usage, { input_tokens: 10, output_tokens: 20, total_tokens: 30, input_tokens_details: { text_tokens: 8, image_tokens: 2 } });

  const urlImage = pm.maskModelFields({ created: 1, data: [{ url: "https://cdn/x.png" }], usage: { total_tokens: 3, cost: 1 } }, OPTS);
  assert.deepEqual(urlImage.usage, { total_tokens: 3 });

  const embed = pm.maskModelFields({ object: "list", model: "e", data: [{ object: "embedding", index: 0, embedding: [0.1] }], usage: { prompt_tokens: 4, total_tokens: 4, cost: 0.0001 } }, OPTS);
  assert.deepEqual(embed.usage, { prompt_tokens: 4, total_tokens: 4 });
  assert.deepEqual(embed.data[0].embedding, [0.1]);
});

test("a non-JSON data line in a customer stream is scrubbed of hosts, URLs and ids", async () => {
  const raw = "data: upstream glm-5.3:pre failed at https://api.zai.example/v1 (zai/glm-5.3:pre) via gw.zai-node.com\n\n";
  const out = await (await pm.maskResponse(sseResponse(raw), OPTS)).text();
  assert.doesNotMatch(out, /glm-5\.3|zai|https?:|example|zai-node/);
  assert.match(out, /^data: upstream glm-5 failed at/);
  // Broken JSON is scrubbed the same way.
  const broken = await (await pm.maskResponse(sseResponse('data: {"model":"glm-5.3:pre",\n\n'), OPTS)).text();
  assert.doesNotMatch(broken, /glm-5\.3/);
  // event:, comments and [DONE] are untouched.
  assert.equal(pm.maskSseLine(": keep-alive glm-5.3:pre", OPTS), ": keep-alive glm-5.3:pre");
  assert.equal(pm.maskSseLine("data: [DONE]", OPTS), "data: [DONE]");
});

test("a byte-order mark does not hide the first line from the mask", async () => {
  // The stream decoder consumes a leading BOM; the line is masked either way.
  const out = await (await pm.maskResponse(sseResponse('﻿data: {"model":"glm-5.3:pre"}\n\n'), OPTS)).text();
  assert.equal(out.replace(/^﻿/, ""), 'data: {"model":"glm-5"}\n\n');
  // A line that still carries one (stored copies, other callers) keeps it and is masked.
  assert.equal(pm.maskSseLine('﻿data: {"model":"glm-5.3:pre"}', OPTS), '﻿data: {"model":"glm-5"}');
  const doc = await (await pm.maskResponse(sseResponse('﻿{\n  "model": "glm-5.3:pre"\n}'), OPTS)).text();
  assert.deepEqual(JSON.parse(doc), { model: "glm-5" });
});

test("usage/key allowedModels holds combo names only for a customer", () => {
  assert.deepEqual(cm.customerVisibleModelsSync(db, ["glm-5", "zai/glm-5.3:pre", "glm-5.3:pre"]), ["glm-5"]);
  assert.equal(cm.customerVisibleModelsSync(db, null), null, "null still means every model");
});

test("the public login settings carry the two flags only", () => {
  const out = publicLoginSettings({ requireLogin: true, tunnelDashboardAccess: false, tunnelUrl: "https://abc.trycloudflare.com", tailscaleUrl: "https://box.tail1234.ts.net" });
  assert.deepEqual(out, { requireLogin: true, tunnelDashboardAccess: false });
});

test("Gemini model lists: combos for customers, the built-in catalog otherwise", () => {
  const models = geminiComboModels([{ id: "glm-5", context_length: 200000 }, { id: "" }]);
  assert.deepEqual(models.map((m) => m.name), ["models/glm-5"]);
  assert.equal(models[0].inputTokenLimit, 200000);
  assert.ok(geminiCatalogModels({ zai: [{ id: "glm-5.3:pre" }] }).some((m) => m.name === "models/zai/glm-5.3:pre"));
});

// ── Round 2: multi-line SSE events ──────────────────────────────────────────

const maskStream = async (text, chunkSize) =>
  (await pm.maskResponse(new Response(chunkedStream(text, chunkSize), { headers: { "content-type": "text/event-stream" } }), OPTS)).text();

const MULTILINE_JSON = 'data: {"id":"gen-1","model":"glm-5.3:pre","provider":"zai",\n'
  + 'data: "choices":[{"delta":{"content":"see  docs.python.org  for x"}}]}\n\n'
  + "data: [DONE]\n\n";

test("a JSON event split over several data lines is masked once; its content is untouched", async () => {
  for (const size of [MULTILINE_JSON.length, 1, 7, 50]) {
    const out = await maskStream(MULTILINE_JSON, size);
    const dataLines = out.split("\n").filter((l) => l.startsWith("data: {"));
    assert.equal(dataLines.length, 1, `one data line (chunk size ${size})`);
    const event = JSON.parse(dataLines[0].slice(6));
    assert.equal(event.choices[0].delta.content, "see  docs.python.org  for x", "content never changes");
    assert.equal(event.model, "glm-5");
    assert.equal(event.provider, undefined);
    assert.match(event.id, /^chatcmpl-/);
    assert.match(out, /\n\ndata: \[DONE\]\n\n$/);
  }
});

test("a multi-line text event is scrubbed and keeps its line structure", async () => {
  const text = "event: error\ndata: upstream glm-5.3:pre failed\ndata: see https://api.zai.example/v1 for zai/glm-5.3:pre\n\n";
  const out = await maskStream(text, 5);
  assert.equal(out.split("\n").filter((l) => l.startsWith("data:")).length, 2);
  assert.match(out, /^event: error\ndata: upstream glm-5 failed\ndata: see for glm-5\n\n$/);
});

test("chunk boundaries inside a line and inside an event, and CRLF endings", async () => {
  const crlf = 'event: message_start\r\ndata: {"type":"message_start",\r\ndata: "message":{"id":"msg_bdrk_1","model":"glm-5.3:pre","content":[]}}\r\n\r\n'
    + 'data: {"type":"content_block_delta","delta":{"text":"x  y.com"}}\r\n\r\n';
  for (const size of [1, 3, 11, crlf.length]) {
    const out = await maskStream(crlf, size);
    assert.doesNotMatch(out, /glm-5\.3|bdrk/);
    assert.match(out, /^event: message_start\r\ndata: \{"type":"message_start","message":\{"id":"msg_[0-9a-f]{32}","model":"glm-5","content":\[\]\}\}\r\n\r\n/);
    assert.match(out, /data: \{"type":"content_block_delta","delta":\{"text":"x  y\.com"\}\}\r\n\r\n$/, "content untouched");
  }
});

test("an event over the cap fails closed; the stream goes on", async () => {
  const big = `data: {"model":"glm-5.3:pre","x":"${"a".repeat(70 * 1024)}"}\n\ndata: {"model":"glm-5.3:pre"}\n\n`;
  const out = await maskStream(big, 4096);
  const events = out.split("\n\n").filter(Boolean);
  assert.equal(JSON.parse(events[0].slice(6)).error.code, "model_error");
  assert.equal(events[1], 'data: {"model":"glm-5"}');
  assert.doesNotMatch(out, /glm-5\.3/);
});

test("stored SSE copies are masked event by event", () => {
  const out = pm.maskStoredResponse(MULTILINE_JSON, OPTS);
  assert.match(out, /"content":"see {2}docs\.python\.org {2}for x"/);
  assert.doesNotMatch(out, /glm-5\.3|"provider"/);
});

test("image stream events keep only standard usage", () => {
  const ev = pm.maskModelFields({ type: "image_generation.completed", b64_json: "AAAA", usage: { input_tokens: 5, output_tokens: 9, total_tokens: 14, input_tokens_details: { text_tokens: 5, image_tokens: 0 }, output_tokens_details: { image_tokens: 9, text_tokens: 0 }, cost: 0.2 } }, OPTS);
  assert.deepEqual(ev.usage, { input_tokens: 5, output_tokens: 9, total_tokens: 14, input_tokens_details: { text_tokens: 5, image_tokens: 0 }, output_tokens_details: { image_tokens: 9, text_tokens: 0 } });
  assert.equal(ev.b64_json, "AAAA");
});

// ── Round 4: truncated stored payloads ──────────────────────────────────────

const MAX_JSON_SIZE = 5 * 1024; // the observability default (maxJsonSize)
const bigTools = Array.from({ length: 40 }, (_, i) => ({ type: "function", name: `t${i}`, description: "x".repeat(150), parameters: {} }));
const STORED_REQUESTS = {
  // A chat request with a short message and a large tools array.
  chat: { messages: [{ role: "user", content: "hi" }], model: "zai/glm-5.3:pre", stream: true, tools: bigTools },
  // A Responses (Codex) request: no `messages`, so `model` sits at the very start.
  responses: { messages: [], model: "zai/glm-5.3:pre", stream: true, tools: bigTools, metadata: { provider: "zai" } },
};

for (const [shape, request] of Object.entries(STORED_REQUESTS)) {
  test(`a ${shape}-shaped request over the size cap leaks nothing to a customer`, () => {
    const stored = detailsRepo.truncateField(request, MAX_JSON_SIZE);
    assert.equal(stored._truncated, true);
    assert.equal(stored.model, "zai/glm-5.3:pre", "the model is a field of its own, not inside the cut preview");
    assert.doesNotMatch(stored._preview, /glm-5\.3/);

    const detail = {
      id: "2026-11-01T10:00:00.000Z-abcdefabcdef", timestamp: "2026-11-01T10:00:00.000Z", provider: "zai",
      model: "glm-5.3:pre", requestedModel: "glm-5", connectionId: "conn-1", status: "success",
      request: stored, response: detailsRepo.truncateField({ content: "y".repeat(6000), model: "glm-5.3:pre", provider: "zai" }, MAX_JSON_SIZE),
      tokens: { prompt_tokens: 1, completion_tokens: 1 },
    };
    for (const out of [details.scrubDetailForList(detail, true, true), details.scrubDetail(detail, true, true), details.scrubDetail(detail, false, true)]) {
      const text = JSON.stringify(out);
      assert.doesNotMatch(text, /glm-5\.3|zai|conn-1/, `no upstream model, provider or connection anywhere (${shape})`);
      assert.equal(JSON.stringify(out).includes("_preview"), false);
    }
    const customer = details.scrubDetailForList(detail, true, true);
    assert.equal(customer.request._truncated, true);
    assert.equal(customer.request.model, "glm-5");

    // An admin key still reads the stored model and the preview.
    const admin = details.scrubDetailForList(detail, true, false);
    assert.equal(admin.request.model, "zai/glm-5.3:pre");
    assert.equal(typeof admin.request._preview, "string");
  });
}

test("a stored JSON string that mentions data: is masked as JSON, not passed as SSE", () => {
  const stored = JSON.stringify({ id: "gen-1", model: "glm-5.3:pre", provider: "zai", choices: [{ message: { content: "Embed it as data:image/png;base64,xyz" } }] });
  const out = JSON.parse(pm.maskStoredResponse(stored, OPTS));
  assert.equal(out.model, "glm-5");
  assert.equal(out.provider, undefined);
  assert.equal(out.choices[0].message.content, "Embed it as data:image/png;base64,xyz");
  const pretty = pm.maskStoredResponse(JSON.stringify({ model: "glm-5.3:pre", provider: "zai", content: "data: x" }, null, 2), OPTS);
  assert.doesNotMatch(pretty, /glm-5\.3|zai/);
});

// ── Round 3: release timing (streams without blank lines) ───────────────────
//
// The engine's passthrough forwards an upstream's lines as received and never
// adds the blank line that ends an SSE event. Each piece is written to the mask
// and what it releases is read before the next piece is written: a line must
// come out in the same step it went in.

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Feed `pieces` one by one; returns what the mask released after each piece, and at the end. */
async function stepwise(pieces) {
  const mask = pm.createSseMaskStream(OPTS);
  const writer = mask.writable.getWriter();
  const reader = mask.readable.getReader();
  const releases = [];
  // One read is kept pending across steps (a read that timed out is not lost:
  // its value belongs to the next step). The pending read is also what lets the
  // transform run (the readable side applies backpressure).
  let pendingRead = null;
  const drain = async () => {
    let text = "";
    for (;;) {
      pendingRead ??= reader.read();
      const next = await Promise.race([pendingRead, new Promise((resolve) => setTimeout(() => resolve(null), 20))]);
      if (!next) break;
      pendingRead = null;
      if (next.done) break;
      text += dec.decode(next.value, { stream: true });
    }
    return text;
  };
  for (const piece of pieces) {
    const written = writer.write(enc.encode(piece));
    releases.push(await drain());
    await written;
  }
  const closing = writer.close();
  let tail = "";
  for (;;) {
    const next = await (pendingRead ?? reader.read());
    pendingRead = null;
    if (next.done) break;
    tail += dec.decode(next.value, { stream: true });
  }
  await closing;
  return { releases, tail };
}

const openaiChunk = (i) => `{"id":"gen-${i}","model":"glm-5.3:pre","provider":"Fireworks","system_fingerprint":"fp_x","choices":[{"delta":{"content":"tok${i} see  docs.python.org"}}]}`;

test("(b) data lines without blank lines are each released as they arrive", async () => {
  const { releases, tail } = await stepwise([0, 1, 2].map((i) => `data: ${openaiChunk(i)}\n`).concat(["data: [DONE]\n"]));
  releases.slice(0, 3).forEach((text, i) => {
    assert.ok(text.startsWith("data: {"), `chunk ${i} released in its own step`);
    const event = JSON.parse(text.slice(6));
    assert.equal(event.choices[0].delta.content, `tok${i} see  docs.python.org`, "content unchanged");
    assert.equal(event.model, "glm-5");
    assert.equal(event.provider, undefined);
    assert.equal(event.system_fingerprint, undefined);
    assert.match(event.id, /^chatcmpl-/);
  });
  assert.equal(releases[3], "data: [DONE]\n");
  assert.equal(tail, "");
});

test("(f2) Anthropic event/data pairs without blank lines are released pair by pair", async () => {
  const { releases } = await stepwise([
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_bdrk_1","model":"glm-5.3:pre","usage":{"input_tokens":1,"cost":3}}}\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi  x.com"}}\n',
  ]);
  assert.match(releases[0], /^event: message_start\ndata: \{"type":"message_start","message":\{"id":"msg_[0-9a-f]{32}","model":"glm-5","usage":\{"input_tokens":1\}\}\}\n$/);
  assert.equal(releases[1], 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi  x.com"}}\n');
});

test("(h) keepalive comments without blank lines pass at once", async () => {
  const { releases } = await stepwise([": keepalive\n", `data: ${openaiChunk(0)}\n`, ": keepalive\n", `data: ${openaiChunk(1)}\n`]);
  assert.equal(releases[0], ": keepalive\n");
  assert.match(releases[1], /^data: \{"id":"chatcmpl-/);
  assert.equal(releases[2], ": keepalive\n");
  assert.match(releases[3], /"content":"tok1 see {2}docs\.python\.org"/);
});

test("a standard stream with blank lines gains no latency", async () => {
  const { releases } = await stepwise([0, 1].map((i) => `data: ${openaiChunk(i)}\n\n`));
  for (const text of releases) assert.match(text, /^data: \{.*\}\n\n$/);
});

test("a genuine multi-line JSON event split across chunks is joined", async () => {
  const { releases, tail } = await stepwise([
    'data: {"id":"gen-1","model":"glm-',
    '5.3:pre","provider":"zai",\ndata: "choices":[{"delta":{"content":"a  b.com"}}',
    "]}\n",
    "\n",
  ]);
  assert.equal(releases[0], "");
  assert.equal(releases[1], "", "the first fragment is held: it does not close");
  const event = JSON.parse(releases[2].slice(6));
  assert.equal(event.choices[0].delta.content, "a  b.com");
  assert.equal(event.model, "glm-5");
  assert.equal(event.provider, undefined);
  assert.equal(releases[3], "\n");
  assert.equal(tail, "");
});

test("an overflow on a stream without blank lines fails that event only; the stream goes on", async () => {
  // Cap is 64 KiB here (STREAM_MAX_BUFFER_BYTES set above).
  // A line that keeps arriving past the cap, in network-sized pieces.
  const huge = `data: {"model":"glm-5.3:pre","x":"${"a".repeat(100 * 1024)}"}\n`;
  const hugePieces = [];
  for (let i = 0; i < huge.length; i += 8192) hugePieces.push(huge.slice(i, i + 8192));
  const { releases } = await stepwise([`data: ${openaiChunk(0)}\n`, ...hugePieces, `data: ${openaiChunk(1)}\n`, "data: [DONE]\n"]);
  assert.match(releases[0], /"content":"tok0/);
  const errorAt = releases.findIndex((text) => text.includes("model_error"));
  assert.ok(errorAt > 0 && errorAt < hugePieces.length, "the error is released while the line is still arriving");
  assert.equal(JSON.parse(releases[errorAt].slice(6)).error.code, "model_error");
  assert.match(releases.at(-2), /"content":"tok1 see {2}docs\.python\.org"/, "the next line still arrives, in its own step");
  assert.equal(releases.at(-1), "data: [DONE]\n");
  assert.doesNotMatch(releases.join(""), /glm-5\.3|Fireworks|aaaa/);
});

test("a complete line larger than the cap is masked, not dropped (nothing is held for it)", async () => {
  const big = `data: {"model":"glm-5.3:pre","choices":[{"delta":{"content":"${"b".repeat(70 * 1024)}"}}]}\n`;
  const { releases } = await stepwise([big]);
  const event = JSON.parse(releases[0].slice(6));
  assert.equal(event.model, "glm-5");
  assert.equal(event.choices[0].delta.content.length, 70 * 1024);
});

test("an oversized multi-line event fails closed, its continuation is dropped, the stream goes on", async () => {
  const fragment = (i) => `data: "k${i}":"${"a".repeat(1024)}",\n`;
  const pieces = ['data: {"model":"glm-5.3:pre",\n', ...Array.from({ length: 70 }, (_, i) => fragment(i)), 'data: "end":1}\n', `data: ${openaiChunk(1)}\n`];
  const { releases } = await stepwise(pieces);
  const all = releases.join("");
  const lines = all.split("\n").filter(Boolean);
  assert.equal(JSON.parse(lines[0].slice(6)).error.code, "model_error");
  assert.equal(lines.length, 2, "only the error and the next event");
  assert.match(lines[1], /"content":"tok1/);
});

test("one oversized event in a standard stream", async () => {
  const huge = `data: {"model":"glm-5.3:pre","x":"${"a".repeat(70 * 1024)}"}\n\n`;
  const out = await maskStream(`data: ${openaiChunk(0)}\n\n${huge}data: ${openaiChunk(1)}\n\ndata: [DONE]\n\n`, 4096);
  const events = out.split("\n\n").filter(Boolean);
  assert.equal(events.length, 4);
  assert.equal(JSON.parse(events[1].slice(6)).error.code, "model_error");
  assert.match(events[2], /"content":"tok1/);
  assert.equal(events[3], "data: [DONE]");
});

test("a stored copy without blank lines is masked line by line, content intact", () => {
  const stored = [0, 1].map((i) => `data: ${openaiChunk(i)}`).join("\n") + "\ndata: upstream glm-5.3:pre failed at https://api.zai.example/v1\ndata: [DONE]\n";
  const out = pm.maskStoredResponse(stored, OPTS);
  const lines = out.split("\n").filter(Boolean);
  assert.equal(lines.length, 4);
  assert.equal(JSON.parse(lines[0].slice(6)).choices[0].delta.content, "tok0 see  docs.python.org");
  assert.equal(lines[2], "data: upstream glm-5 failed at");
  assert.doesNotMatch(out, /glm-5\.3|Fireworks|zai/);
});

test("valid JSON lines that do not join are each masked as JSON, never scrubbed as text", async () => {
  const out = await maskStream(`data: ${openaiChunk(0)}\ndata: ${openaiChunk(1)}\n\n`, 9);
  const lines = out.split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
  lines.forEach((line, i) => assert.equal(JSON.parse(line.slice(6)).choices[0].delta.content, `tok${i} see  docs.python.org`));
});

test("SSE id: lines are scrubbed of hidden ids and hosts for a customer", async () => {
  const out = await maskStream("id: zai/glm-5.3:pre-77@gw.zai-node.com\ndata: {\"model\":\"glm-5.3:pre\"}\n\nid: 42\ndata: [DONE]\n\n", 5);
  assert.doesNotMatch(out, /glm-5\.3|zai/);
  assert.match(out, /^id: glm-5@\n/, "the upstream id (and its variant suffix) and the host are gone");
  assert.match(out, /\nid: 42\n/, "other ids unchanged");
});

test("processes creating the sealed-id secret at the same time all use the one on disk", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-sealed-race-"));
  try {
    const ids = await sealInProcesses(dataDir, 8);
    assert.equal(new Set(ids).size, 1, "one secret for every process (sealing is deterministic)");
    const secret = fs.readFileSync(path.join(dataDir, "auth", "sealed-id-secret"), "utf8");
    assert.match(secret, /^[0-9a-f]{64}$/);
    assert.deepEqual(fs.readdirSync(path.join(dataDir, "auth")), ["sealed-id-secret"], "no temporary files left behind");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

/** Seal "same-row" in `count` fresh processes on `dataDir`, started together. */
async function sealInProcesses(dataDir, count) {
  return (await sealInProcessesTimed(dataDir, count)).map((run) => run.id);
}

/** Same, with how long each process spent in its first sealId (loading the secret). */
async function sealInProcessesTimed(dataDir, count) {
  const { spawn } = await import("node:child_process");
  const moduleUrl = new URL("../src/lib/crypto/sealedIds.js", import.meta.url).href;
  const script = `const m = await import(${JSON.stringify(moduleUrl)}); const t = performance.now(); const id = m.sealId("request-detail", "same-row"); process.stdout.write(JSON.stringify({ id, ms: performance.now() - t }));`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, DATA_DIR: dataDir }, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`child exited ${code}`))));
  });
  return Promise.all(Array.from({ length: count }, run));
}

test("an old empty slot is skipped at once, every start, and processes agree", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-sealed-old-empty-"));
  try {
    const file = path.join(dataDir, "auth", "sealed-id-secret");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, ""); // a leftover: crash, full disk or a stray `touch`
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(file, old, old);
    fs.writeFileSync(`${file}.1`, "cd".repeat(32));
    for (let start = 0; start < 2; start += 1) {
      const runs = await sealInProcessesTimed(dataDir, 4);
      assert.equal(new Set(runs.map((run) => run.id)).size, 1, "one secret for every process");
      for (const run of runs) assert.ok(run.ms < 500, `loaded in ${Math.round(run.ms)} ms`);
    }
    assert.equal(fs.existsSync(`${file}.2`), false);
    assert.equal(fs.readFileSync(file, "utf8"), "", "the leftover is never rewritten");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("an unusable secret store falls back to memory with one warning and no secret in it", async () => {
  const { spawnSync } = await import("node:child_process");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-sealed-unusable-"));
  try {
    const auth = path.join(dataDir, "auth");
    fs.mkdirSync(auth, { recursive: true });
    for (let index = 0; index < 8; index += 1) {
      fs.writeFileSync(path.join(auth, index === 0 ? "sealed-id-secret" : `sealed-id-secret.${index}`), "corrupt!");
    }
    const moduleUrl = new URL("../src/lib/crypto/sealedIds.js", import.meta.url).href;
    const script = `const m = await import(${JSON.stringify(moduleUrl)}); m.sealId("p", "a"); m.sealId("p", "b"); process.stdout.write("ok");`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, DATA_DIR: dataDir }, encoding: "utf8" });
    assert.equal(result.stdout, "ok");
    const warnings = result.stderr.split("\n").filter((line) => line.includes("[sealed-ids]"));
    assert.equal(warnings.length, 1, "warned once");
    assert.match(warnings[0], /in-memory secret/);
    assert.doesNotMatch(warnings[0], /[0-9a-f]{32}/, "no secret in the warning");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("processes starting against a corrupted secret file agree on one new secret", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-sealed-corrupt-"));
  try {
    fs.mkdirSync(path.join(dataDir, "auth"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "auth", "sealed-id-secret"), "not a secret at all\n");
    const ids = await sealInProcesses(dataDir, 8);
    assert.equal(new Set(ids).size, 1);
    assert.equal(fs.readFileSync(path.join(dataDir, "auth", "sealed-id-secret"), "utf8"), "not a secret at all\n", "a corrupted slot is never rewritten");
    assert.match(fs.readFileSync(path.join(dataDir, "auth", "sealed-id-secret.1"), "utf8"), /^[0-9a-f]{64}$/);
    const later = await sealInProcesses(dataDir, 2);
    assert.equal(new Set([...later, ids[0]]).size, 1, "later processes use the same one");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a creator that stalls mid-write is waited for, not raced", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-sealed-stall-"));
  try {
    const file = path.join(dataDir, "auth", "sealed-id-secret");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const secret = "ab".repeat(32);
    fs.writeFileSync(file, secret.slice(0, 20)); // half-written, as a stalled creator leaves it
    const pending = sealInProcesses(dataDir, 4);
    // Completed while still young (a few hundred ms, inside the youth window).
    await new Promise((resolve) => setTimeout(resolve, 250));
    fs.writeFileSync(file, secret);
    const ids = await pending;
    assert.equal(new Set(ids).size, 1);
    assert.equal(fs.existsSync(`${file}.1`), false, "nobody gave up and created another secret");
    assert.equal(fs.readFileSync(file, "utf8"), secret);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ── Round 2: sealed ids ─────────────────────────────────────────────────────

test("every sealed id has the same length, whatever it hides", () => {
  const short = sealed.sealId("request-detail", "2026-11-21T10:00:00.000Z-abcdefghijkl");
  const long = sealed.sealId("request-detail", "2026-11-01T10:00:00.000Z-ab12cd-accounts-fireworks-models-deepseek-v3p1-terminus");
  const max = sealed.sealId("request-detail", "x".repeat(sealed.SEALED_PLAINTEXT_BYTES));
  assert.equal(short.length, sealed.SEALED_ID_LENGTH);
  assert.equal(long.length, short.length);
  assert.equal(max.length, short.length);
  assert.equal(sealed.sealId("request-detail", "x".repeat(sealed.SEALED_PLAINTEXT_BYTES + 1)), null, "too long to hide: not sealed");
  assert.equal(sealed.openSealedId("request-detail", long), "2026-11-01T10:00:00.000Z-ab12cd-accounts-fireworks-models-deepseek-v3p1-terminus");

  // A row whose id cannot be sealed is referenced by its timestamp, never a longer id.
  assert.equal(details.publicDetailId({ id: "y".repeat(400), timestamp: "2026-11-01T10:00:00.000Z" }), "2026-11-01T10:00:00.000Z");
});

test("a sealed id opens only for its purpose and only unaltered", () => {
  const id = sealed.sealId("request-detail", "row-1");
  assert.equal(sealed.openSealedId("request-detail", id), "row-1");
  assert.equal(sealed.openSealedId("other-purpose", id), null, "wrong purpose");

  const middle = Math.floor(id.length / 2);
  const flipped = id.slice(0, middle) + (id[middle] === "A" ? "B" : "A") + id.slice(middle + 1);
  assert.notEqual(flipped, id);
  assert.equal(flipped.length, id.length);
  assert.equal(sealed.openSealedId("request-detail", flipped), null, "a forged id opens nothing");
  assert.equal(sealed.openSealedId("request-detail", id.slice(0, -1)), null);
});

test("the sealed-id secret is its own random file, never the machine id", () => {
  sealed.sealId("request-detail", "warm-up");
  const file = path.join(tmpDir, "auth", "sealed-id-secret");
  const secret = fs.readFileSync(file, "utf8").trim();
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  let machineId = null;
  try { machineId = fs.readFileSync(path.join(tmpDir, "machine-id"), "utf8").trim(); } catch { /* not created */ }
  assert.notEqual(secret, machineId);
  assert.doesNotMatch(fs.readFileSync(new URL("../src/lib/crypto/sealedIds.js", import.meta.url), "utf8"), /machine-?id(Sync)?\(|readRawMachineId|node-machine-id/i);
});
