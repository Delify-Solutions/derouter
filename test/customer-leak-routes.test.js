// Customer leak fixes, exercised through the real route handlers and translators
// (change customer-leak-fixes, spec model-privacy). Route modules are written for
// Next.js: the "@/" alias, bare "open-sse/" and "next/server" are resolved by the
// test hooks.
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-customer-leak-routes-"));
process.env.DATA_DIR = tmpDir;
register("./helpers/src-alias-hook.mjs", import.meta.url);
register("./helpers/next-server-hook.mjs", import.meta.url);

const { getAdapter } = await import("../src/lib/db/driver.js");
const { createApiKey } = await import("../src/lib/db/repos/apiKeysRepo.js");
const { createKeyGroup } = await import("../src/lib/db/repos/keyGroupsRepo.js");
const { updateSettings } = await import("../src/lib/db/repos/settingsRepo.js");
const { publicDetailId } = await import("../src/lib/usage/publicRequestDetails.js");
const { PROVIDER_MODELS } = await import("../open-sse/config/providerModels.js");
const { initState } = await import("../open-sse/translator/index.js");
const { FORMATS } = await import("../open-sse/translator/formats.js");
const { openaiToOpenAIResponsesResponse } = await import("../open-sse/translator/response/openai-responses.js");
const { createResponsesApiTransformStream } = await import("../open-sse/transformer/responsesTransformer.js");
const { translateNonStreamingResponse } = await import("../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { __test__: sseToJson } = await import("../open-sse/handlers/chatCore/sseToJsonHandler.js");

const requireLogin = await import("../src/app/api/settings/require-login/route.js");
const v1betaModels = await import("../src/app/api/v1beta/models/route.js");
const geminiNative = await import("../src/app/api/v1beta/models/[...path]/route.js");
const modelsInfo = await import("../src/app/api/v1/models/info/route.js");
const voices = await import("../src/app/api/v1/audio/voices/route.js");
const receiptsDetail = await import("../src/app/api/usage/key/receipts/detail/route.js");
const usageKey = await import("../src/app/api/usage/key/route.js");
const { buildModelPriceList } = await import("../src/lib/models/priceList.js");
const handlerAuth = await import("../src/sse/services/auth.js");
const { extractApiKey } = await import("../src/lib/auth/apiKeyExtract.js");

let db;
let customerKey;
let adminKey;
before(async () => {
  db = await getAdapter();
  const now = new Date().toISOString();
  // The group also lists an upstream id: a customer must never read it back.
  const group = await createKeyGroup({ name: "g", allowedModels: ["glm-5", "zai/glm-5.3:pre"] });
  db.run(`INSERT INTO users(id, email, passwordHash, status, groupId, createdAt) VALUES('u1', 'u1@t.io', 'x', 'active', ?, ?)`, [group.id, now]);
  db.run(`INSERT INTO combos(id, name, models, createdAt, updatedAt) VALUES('c1', 'glm-5', ?, ?, ?)`, [JSON.stringify(["zai/glm-5.3:pre"]), now, now]);
  customerKey = (await createApiKey("cust", "m", { userId: "u1" })).key;
  adminKey = (await createApiKey("ops", "m")).key;
  // A second customer in the same group: the detail lookup must be scoped by key,
  // not merely by "is a customer".
  db.run(`INSERT INTO users(id, email, passwordHash, status, groupId, createdAt) VALUES('u2', 'u2@t.io', 'x', 'active', ?, ?)`, [group.id, now]);
  otherCustomerKey = (await createApiKey("cust2", "m", { userId: "u2" })).key;
});
let otherCustomerKey;
after(async () => {
  // Denial logging and usage rows are written after the response returns.
  await new Promise((resolve) => setTimeout(resolve, 300));
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// No route under test may reach the network.
let realFetch;
let fetchCalls;
beforeEach(() => {
  realFetch = globalThis.fetch;
  fetchCalls = [];
  globalThis.fetch = async (url) => { fetchCalls.push(String(url)); throw new Error("network disabled in tests"); };
});
afterEach(() => { globalThis.fetch = realFetch; });

const bearer = (key) => ({ authorization: `Bearer ${key}` });

// ── CRITICAL-1: translated Responses ids ────────────────────────────────────

const upstreamChunk = (extra) => ({ id: "gen-1763-OpenRouterXyz", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: {}, finish_reason: null }], ...extra });

test("a translated Responses stream carries one router id, never the upstream's", () => {
  const state = initState(FORMATS.OPENAI_RESPONSES);
  const events = [
    ...openaiToOpenAIResponsesResponse(upstreamChunk({ choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "think" }, finish_reason: null }] }), state),
    ...openaiToOpenAIResponsesResponse(upstreamChunk({ choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }] }), state),
    ...openaiToOpenAIResponsesResponse(upstreamChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), state),
  ];
  const text = JSON.stringify(events);
  assert.doesNotMatch(text, /gen-1763|OpenRouterXyz/);
  const ids = new Set(events.map((e) => e.data?.response?.id).filter(Boolean));
  assert.equal(ids.size, 1, "one response id across every event");
  const [responseId] = ids;
  assert.match(responseId, /^resp_[0-9a-f]{32}$/);
  const itemIds = events.flatMap((e) => [e.data?.item?.id, e.data?.item_id]).filter(Boolean);
  assert.ok(itemIds.length > 0);
  for (const id of itemIds) assert.ok(id.includes(responseId), `item id ${id} derives from the router id`);
});

test("the Responses transform stream (Codex handler) uses a router id", async () => {
  const sse = [upstreamChunk({ choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }] }), upstreamChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })]
    .map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  const out = await new Response(new Response(sse).body.pipeThrough(createResponsesApiTransformStream(null))).text();
  assert.doesNotMatch(out, /gen-1763|OpenRouterXyz/);
  const ids = new Set([...out.matchAll(/"id":"(resp_[^"]+)"/g)].map((m) => m[1]));
  assert.equal(ids.size, 1);
  assert.match([...ids][0], /^resp_[0-9a-f]{32}$/);
});

test("a translated non-streamed Responses body gets a router id; tool-call ids stay", () => {
  const body = { id: "msg_bdrk_01ABC", object: "chat.completion", model: "m", choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: "ok", tool_calls: [{ id: "call_up_7", type: "function", function: { name: "f", arguments: "{}" } }] } }] };
  for (const out of [
    translateNonStreamingResponse(structuredClone(body), FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES),
    sseToJson.chatCompletionToResponses(structuredClone(body)),
  ]) {
    assert.match(out.id, /^resp_[0-9a-f]{32}$/);
    assert.doesNotMatch(out.id, /bdrk/);
    const call = out.output.find((item) => item.call_id);
    assert.equal(call.call_id, "call_up_7", "tool-call ids are never changed");
  }
});

// ── WARNING-4: detail ids resolve on any page ───────────────────────────────

test("a customer's detail id from beyond the first 100 rows resolves, and only for that key", async () => {
  const base = Date.parse("2026-11-01T00:00:00.000Z");
  for (let i = 0; i < 150; i += 1) {
    const ts = new Date(base + i * 60_000).toISOString();
    const id = `${ts}-r${String(i).padStart(4, "0")}-glm-5-3-pre`;
    const data = { id, timestamp: ts, provider: "zai", model: "glm-5.3:pre", requestedModel: "glm-5", connectionId: "conn-1", apiKey: customerKey, status: "success", tokens: { prompt_tokens: 1, completion_tokens: 1 } };
    db.run(`INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, apiKey, status, data) VALUES(?, ?, 'zai', 'glm-5.3:pre', 'conn-1', ?, 'success', ?)`, [id, ts, customerKey, JSON.stringify(data)]);
  }
  const oldest = { id: `${new Date(base).toISOString()}-r0000-glm-5-3-pre` };
  const call = (key, id) => receiptsDetail.GET(new Request(`http://x/api/usage/key/receipts/detail?key=${encodeURIComponent(key)}&id=${encodeURIComponent(id)}`));

  // Page 3 of 50 lists the oldest rows, each with an opaque id.
  const page3 = await (await receiptsDetail.GET(new Request(`http://x/api/usage/key/receipts/detail?key=${encodeURIComponent(customerKey)}&page=3&pageSize=50`))).json();
  assert.equal(page3.details.length, 50);
  assert.ok(page3.details.every((d) => !("connectionId" in d) && !/glm-5-3|glm-5\.3|conn-1/.test(JSON.stringify(d))));
  assert.ok(page3.details.some((d) => d.id === publicDetailId(oldest)));

  const res = await call(customerKey, publicDetailId(oldest));
  assert.equal(res.status, 200);
  const { detail } = await res.json();
  assert.equal(detail.id, publicDetailId(oldest));
  assert.equal(detail.timestamp, new Date(base).toISOString());

  // Another customer's key (also a hidden-id key) and an admin key cannot open it.
  assert.equal((await call(otherCustomerKey, publicDetailId(oldest))).status, 404);
  assert.equal((await call(adminKey, publicDetailId(oldest))).status, 404);
  // A forged id (one byte flipped in the middle) opens nothing.
  const id = publicDetailId(oldest);
  const middle = Math.floor(id.length / 2);
  const forged = id.slice(0, middle) + (id[middle] === "A" ? "B" : "A") + id.slice(middle + 1);
  assert.notEqual(forged, id);
  assert.equal((await call(customerKey, forged)).status, 404);
});

// ── CRITICAL/MEDIUM: Gemini native TTS ──────────────────────────────────────

const ttsRequest = (headers) => geminiNative.POST(
  new Request("http://x/v1beta/models/gemini-2.5-flash-preview-tts:generateContent", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }], generationConfig: { responseModalities: ["AUDIO"] } }),
  }),
  { params: Promise.resolve({ path: ["gemini-2.5-flash-preview-tts:generateContent"] }) }
);

test("the Gemini native TTS path refuses a customer key before any credential or network", async () => {
  const res = await ttsRequest({ "x-goog-api-key": customerKey });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("x-derouter-error"), "platform");
  assert.equal((await res.json()).error.code, "endpoint_not_available");
  assert.deepEqual(fetchCalls, []);

  // An admin key goes on to the credential lookup (none configured here).
  const admin = await ttsRequest(bearer(adminKey));
  assert.notEqual(admin.status, 403);
  assert.match((await admin.json()).error.message, /credentials/i);
});

// ── Catalogs ────────────────────────────────────────────────────────────────

test("/v1beta/models lists combos only for a customer, the catalog for an admin", async () => {
  const customer = await (await v1betaModels.GET(new Request("http://x/v1beta/models", { headers: { "x-goog-api-key": customerKey } }))).json();
  assert.deepEqual(customer.models.map((m) => m.name), ["models/glm-5"]);

  const admin = await (await v1betaModels.GET(new Request("http://x/v1beta/models", { headers: bearer(adminKey) }))).json();
  assert.ok(admin.models.length > 1);
  assert.ok(admin.models.some((m) => m.name.split("/").length === 3), "provider/model entries for an admin");
});

test("/v1/models/info answers 404 to a customer and the entry to an admin", async () => {
  const [alias, list] = Object.entries(PROVIDER_MODELS).find(([, models]) => models.length > 0);
  const url = `http://x/v1/models/info?id=${encodeURIComponent(`${alias}/${list[0].id}`)}`;
  assert.equal((await modelsInfo.GET(new Request(url, { headers: bearer(customerKey) }))).status, 404);
  assert.equal((await modelsInfo.GET(new Request(`${url}&key=${encodeURIComponent(customerKey)}`))).status, 404, "a key in ?key= is the same key");
  const admin = await modelsInfo.GET(new Request(url, { headers: bearer(adminKey) }));
  assert.equal(admin.status, 200);
  assert.equal((await admin.json()).id, `${alias}/${list[0].id}`);
});

test("/v1/audio/voices refuses a customer and serves an admin in-process, never over the network", async () => {
  const customer = await voices.GET(new Request("http://evil.example/v1/audio/voices?provider=deepgram", { headers: bearer(customerKey) }));
  assert.equal(customer.status, 403);
  assert.equal((await customer.json()).error.code, "endpoint_not_available");

  // No Deepgram connection: the internal handler itself answers (no fetch to the
  // caller's host, no 401 from the admin guard).
  const admin = await voices.GET(new Request("http://evil.example/v1/audio/voices?provider=deepgram", { headers: bearer(adminKey) }));
  assert.equal(admin.status, 400);
  assert.match((await admin.json()).error.message, /No Deepgram connection/);
  assert.deepEqual(fetchCalls, []);
});

test("/v1/audio/voices refuses keyless and unknown keys even with requireApiKey off", async () => {
  await updateSettings({ requireApiKey: false });
  try {
    const keyless = await voices.GET(new Request("http://x/v1/audio/voices?provider=edge-tts"));
    assert.equal(keyless.status, 401);
    assert.equal((await keyless.json()).error.code, "invalid_api_key");
    const unknown = await voices.GET(new Request("http://x/v1/audio/voices?provider=edge-tts", { headers: bearer("sk-not-a-key") }));
    assert.equal(unknown.status, 401);
    assert.deepEqual(fetchCalls, []);
  } finally {
    await updateSettings({ requireApiKey: true });
  }
});

test("/api/settings/require-login never sends the tunnel or Tailscale URL", async () => {
  await updateSettings({ tunnelUrl: "https://abc.trycloudflare.com", tailscaleUrl: "https://box.tail1234.ts.net" });
  const body = await (await requireLogin.GET()).json();
  assert.deepEqual(Object.keys(body).sort(), ["requireLogin", "tunnelDashboardAccess"]);
  assert.doesNotMatch(JSON.stringify(body), /trycloudflare|ts\.net/);
});

test("/api/usage/key returns only combo names in allowedModels for a customer", async () => {
  const customer = await (await usageKey.GET(new Request(`http://x/api/usage/key?key=${encodeURIComponent(customerKey)}`))).json();
  assert.deepEqual(customer.allowedModels, ["glm-5"]);
});

test("the price list carries no combo member count", async () => {
  const rows = await buildModelPriceList({ allowedModels: ["glm-5"] });
  assert.equal(rows.length, 1);
  assert.equal("modelsCount" in rows[0], false);
  assert.doesNotMatch(JSON.stringify(rows), /zai|glm-5\.3/);
});

// ── One key extractor ───────────────────────────────────────────────────────

test("the guard and every handler use the one shared key extractor", async () => {
  assert.equal(handlerAuth.extractApiKey, extractApiKey);
  // The guard cannot be loaded in plain Node (src/shared/utils/machineId.js imports
  // a CommonJS named export only the bundler resolves), so its import is read from
  // the source: it must take the same function and define none of its own.
  const guardSource = fs.readFileSync(new URL("../src/dashboardGuard.js", import.meta.url), "utf8");
  assert.match(guardSource, /import \{ extractApiKey \} from "@\/lib\/auth\/apiKeyExtract\.js"/);
  assert.doesNotMatch(guardSource, /function extractApiKey/);
  // A key the guard reads from ?key= is the key the chat handler enforces. Before,
  // the handler saw no key: with requireApiKey on it answered 401 "Missing API
  // key", with it off it served the request as keyless. Now the customer's plan
  // admission applies (this customer holds no plan).
  const { handleChat } = await import("../src/sse/handlers/chat.js");
  const res = await handleChat(new Request(`http://x/v1/chat/completions?key=${encodeURIComponent(customerKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "zai/glm-5.3:pre", messages: [{ role: "user", content: "hi" }] }),
  }));
  assert.equal(res.status, 402);
  assert.equal(res.headers.get("x-derouter-error"), "platform");
  assert.equal((await res.json()).error.code, "insufficient_quota");
  assert.deepEqual(fetchCalls, []);
});
