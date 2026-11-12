// Customers see combos, never upstream models (spec model-privacy).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-model-privacy-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const pm = await import("../src/lib/models/publicModel.js");
const cm = await import("../src/lib/models/customerModels.js");
const { createApiKey } = await import("../src/lib/db/repos/apiKeysRepo.js");

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

test("hidden ids: members, their bare part and upstream ids, longest first, never the public name", () => {
  assert.deepEqual(OPTS.ids, ["zai/glm-5.3:pre", "glm-5.3:pre"]);
  assert.deepEqual(pm.hiddenProviderIds({ members: ["zai/glm-5.3:pre"], publicName: "glm-5" }), ["zai"], "providers are kept apart");
  assert.deepEqual(pm.hiddenModelIds({ members: ["a/glm-5"], publicName: "glm-5" }), ["a/glm-5"]);
  assert.deepEqual(pm.hiddenModelIds({ upstream: ["x", "ab"] }), [], "too short to scrub safely");
});

test("every response format names the combo", () => {
  const openai = pm.maskModelFields({ id: "c", model: "glm-5.3:pre", choices: [{ message: { content: "glm-5.3:pre rocks" } }] }, OPTS);
  assert.equal(openai.model, "glm-5");
  assert.equal(openai.choices[0].message.content, "glm-5.3:pre rocks", "content is never touched");

  assert.equal(pm.maskModelFields({ type: "message_start", message: { model: "glm-5.3:pre" } }, OPTS).message.model, "glm-5");
  assert.equal(pm.maskModelFields({ type: "response.completed", response: { model: "glm-5.3:pre" } }, OPTS).response.model, "glm-5");
  assert.equal(pm.maskModelFields({ modelVersion: "glm-5.3:pre" }, OPTS).modelVersion, "glm-5");
});

test("error texts are scrubbed of every hidden id", () => {
  const err = pm.maskModelFields({ error: { message: "[zai/glm-5.3:pre] model glm-5.3:pre rejected the tool schema", code: "invalid_api_key_x", metadata: { provider_name: "Fireworks" } } }, OPTS);
  assert.equal(err.error.message, "model glm-5 rejected the tool schema", "the [provider/model] prefix goes, the id is replaced");
  assert.deepEqual(Object.keys(err.error).sort(), ["code", "message", "type"], "no upstream code, metadata or raw body");
  assert.equal(pm.maskModelFields({ error: { message: "glm-5.3:pre is overloaded" } }, OPTS).error.code, "model_overloaded");
  assert.equal(pm.maskModelFields({ type: "error", error: { message: "glm-5.3:pre down" } }, OPTS).error.message, "glm-5 down");
  assert.equal(pm.maskJsonText("upstream glm-5.3:pre failed", OPTS), "upstream glm-5 failed", "plain-text error");
  assert.equal(pm.maskModelFields({ type: "response.failed", response: { error: { message: "glm-5.3:pre" } } }, OPTS).response.error.message, "glm-5");
});

test("an SSE stream is masked even when lines are split across chunks", async () => {
  const enc = new TextEncoder();
  const full = 'data: {"model":"glm-5.3:pre","choices":[]}\n\nevent: message_start\ndata: {"type":"message_start","message":{"model":"glm-5.3:pre"}}\n\ndata: [DONE]\n\n';
  const parts = [full.slice(0, 17), full.slice(17, 60), full.slice(60)];
  const source = new ReadableStream({ start(c) { for (const p of parts) c.enqueue(enc.encode(p)); c.close(); } });
  const out = await new Response(source.pipeThrough(pm.createSseMaskStream(OPTS))).text();
  assert.doesNotMatch(out, /glm-5\.3/);
  assert.match(out, /"model":"glm-5"/);
  assert.match(out, /event: message_start\n/);
  assert.match(out, /data: \[DONE\]\n\n$/);
});

test("maskResponse rewrites JSON and SSE, leaves other content alone", async () => {
  const json = new Response(JSON.stringify({ model: "glm-5.3:pre" }), { status: 200, headers: { "content-type": "application/json" } });
  assert.equal((await (await pm.maskResponse(json, OPTS)).json()).model, "glm-5");

  const sse = new Response('data: {"model":"glm-5.3:pre"}\n\n', { headers: { "content-type": "text/event-stream" } });
  assert.equal(await (await pm.maskResponse(sse, OPTS)).text(), 'data: {"model":"glm-5"}\n\n');

  const audio = new Response("RIFF", { headers: { "content-type": "audio/wav" } });
  assert.equal(await pm.maskResponse(audio, OPTS), audio);
});

test("a stored response (receipts with raw payloads) is masked at any depth", () => {
  const stored = { body: { model: "glm-5.3:pre", nested: [{ modelVersion: "glm-5.3:pre" }] }, error: { message: "glm-5.3:pre" } };
  const out = pm.maskStoredResponse(stored, OPTS);
  assert.doesNotMatch(JSON.stringify(out), /glm-5\.3/);
  assert.match(pm.maskStoredResponse('data: {"model":"glm-5.3:pre"}\n', OPTS), /"model":"glm-5"/);
});

test("a customer key calls combos only; an admin key and the switch keep the old behaviour", () => {
  assert.equal(cm.customerMayCallSync(db, { apiKey: customerKey, model: "glm-5" }), true);
  assert.equal(cm.customerMayCallSync(db, { apiKey: customerKey, model: "zai/glm-5.3:pre" }), false);
  assert.equal(cm.customerMayCallSync(db, { apiKey: customerKey, model: "glm-5.3:pre" }), false);
  assert.equal(cm.customerMayCallSync(db, { apiKey: adminKey, model: "zai/glm-5.3:pre" }), true);
  assert.equal(cm.customerMayCallSync(db, { apiKey: customerKey, model: "zai/glm-5.3:pre", settings: { hideUpstreamModels: false } }), true);
});

test("the response mask applies to customer keys only", () => {
  const ctx = cm.publicModelContextSync(db, {}, { apiKey: customerKey, publicName: "glm-5", members: ["zai/glm-5.3:pre"], upstream: new Set(["glm-5.3:pre"]) });
  assert.equal(ctx.publicName, "glm-5");
  assert.ok(ctx.ids.includes("glm-5.3:pre"));
  assert.equal(cm.publicModelContextSync(db, {}, { apiKey: adminKey, publicName: "glm-5" }), null);
  assert.equal(cm.publicModelContextSync(db, { hideUpstreamModels: false }, { apiKey: customerKey, publicName: "glm-5" }), null);
});

test("an upstream error is reworded for a customer; a router denial keeps its message", async () => {
  const upstream401 = new Response(JSON.stringify({
    error: { message: "[openai-compatible-chat-x/glm-5.3:pre] [401]: Incorrect API key provided: sk-mock. See https://platform.openai.com", type: "invalid_request_error", code: "invalid_api_key" },
    cycleGuard: { visited: ["glm-5", "zai/glm-5.3:pre"] },
  }), { status: 401, headers: { "content-type": "application/json" } });
  const body401 = await (await pm.maskResponse(upstream401, OPTS)).json();
  assert.deepEqual(Object.keys(body401), ["error"], "cycleGuard and any other field are dropped");
  assert.equal(body401.error.code, "model_unavailable", "never the upstream's invalid_api_key");
  assert.doesNotMatch(JSON.stringify(body401), /openai|glm-5\.3|sk-mock|zai/);

  const busy = await pm.maskResponse(new Response(JSON.stringify({ error: { message: "rate limited on glm-5.3:pre" } }), {
    status: 429, headers: { "content-type": "application/json", "retry-after": "7" },
  }), OPTS);
  assert.equal(busy.status, 429);
  assert.equal(busy.headers.get("retry-after"), "7");
  assert.equal((await busy.json()).error.code, "model_overloaded");

  const bad = await (await pm.maskResponse(new Response(JSON.stringify({ error: { message: "[zai/glm-5.3:pre] [400]: {\"error\":{\"message\":\"max_tokens too large for glm-5.3:pre\"}}" } }), {
    status: 400, headers: { "content-type": "application/json" },
  }), OPTS)).json();
  assert.equal(bad.error.message, "max_tokens too large for glm-5", "a request problem keeps its explanation");

  const comboWrapped = await (await pm.maskResponse(new Response(JSON.stringify({ error: { message: "[zai/glm-5.3:pre] [400]: bad temperature (reset after 30s)" } }), {
    status: 503, headers: { "content-type": "application/json" },
  }), OPTS)).json();
  assert.equal(comboWrapped.error.code, "invalid_request", "a combo's 503 around a 400 still reads as a request problem");
  assert.equal(comboWrapped.error.message, "bad temperature");

  const size = await (await pm.maskResponse(new Response("prompt is too long for glm-5.3:pre", { status: 400 }), OPTS)).json();
  assert.equal(size.error.code, "context_length_exceeded");

  const platform = await pm.maskResponse(new Response(JSON.stringify({ error: { message: "Gói đã hết credit", code: "insufficient_credit" } }), {
    status: 402, headers: { "content-type": "application/json", "X-Derouter-Error": "platform" },
  }), OPTS);
  assert.deepEqual(await platform.json(), { error: { message: "Gói đã hết credit", code: "insufficient_credit" } });
});

test("a provider field from an aggregator is dropped", () => {
  const out = pm.maskModelFields({ model: "glm-5.3:pre", provider: "Fireworks", choices: [] }, OPTS);
  assert.equal(out.provider, undefined);
  assert.equal(out.model, "glm-5");
});

test("provider-account problems never read as the customer's own key, whatever the status", async () => {
  const gemini = await (await pm.maskResponse(new Response(JSON.stringify({ error: { message: "API key not valid. Please pass a valid API key." } }), {
    status: 400, headers: { "content-type": "application/json" },
  }), OPTS)).json();
  assert.equal(gemini.error.code, "model_unavailable");

  const noCreds = await (await pm.maskResponse(new Response(JSON.stringify({ error: { message: "No active credentials for provider: zai" } }), {
    status: 404, headers: { "content-type": "application/json" },
  }), OPTS)).json();
  assert.equal(noCreds.error.code, "model_unavailable");
  assert.doesNotMatch(JSON.stringify(noCreds), /zai/);

  const tpm = await (await pm.maskResponse(new Response(JSON.stringify({ error: { message: "Request too large for tokens per min" } }), {
    status: 429, headers: { "content-type": "application/json" },
  }), OPTS)).json();
  assert.equal(tpm.error.code, "model_overloaded", "a 429 is a rate limit, not a size problem");
});

test("host names, key fragments and replacement patterns never leak", () => {
  assert.equal(pm.cleanUpstreamMessage("fetch failed: getaddrinfo ENOTFOUND glm.internal-node.example.com", OPTS), "fetch failed: getaddrinfo ENOTFOUND");
  assert.equal(pm.scrubModelIds("x glm-5.3:pre y", ["glm-5.3:pre"], "a$&b"), "x a$&b y", "the public name is inserted literally");
});

test("a stored error row is rebuilt like the live error", () => {
  const stored = { error: "[401]: Incorrect API key provided: sk-proj-abcd****wxyz. You can find your API key at https://platform.openai.com", status: 401, thinking: null };
  const out = pm.maskStoredResponse(stored, OPTS);
  assert.equal(out.code, "model_unavailable");
  assert.equal(out.status, 401);
  assert.doesNotMatch(JSON.stringify(out), /sk-proj|openai|platform/);
});

test("a 200 text body is content and is left alone", async () => {
  const text = new Response("glm-5.3:pre says hi", { headers: { "content-type": "text/plain" } });
  assert.equal(await (await pm.maskResponse(text, OPTS)).text(), "glm-5.3:pre says hi");
});

test("the customer ledger shows the combo, never the upstream model", async () => {
  const { getAccountLedgerSync } = await import("../src/lib/db/repos/accountPlansRepo.js");
  const now = new Date().toISOString();
  db.run(`INSERT INTO usageHistory(id, timestamp, provider, model, promptTokens, completionTokens, meta) VALUES(901, ?, 'zai', 'glm-5.3:pre', 3, 1, ?)`, [now, JSON.stringify({ requestedModel: "glm-5" })]);
  db.run(`INSERT INTO usageHistory(id, timestamp, provider, model, promptTokens, completionTokens, meta) VALUES(902, ?, 'zai', 'glm-5.3:pre', 3, 1, '{}')`, [now]);
  db.run(`INSERT INTO creditLedger(userId, usageId, deltaNanoUsd, kind, createdAt) VALUES('u1', 901, -1, 'charge', ?)`, [now]);
  db.run(`INSERT INTO creditLedger(userId, usageId, deltaNanoUsd, kind, createdAt) VALUES('u1', 902, -1, 'charge', ?)`, [now]);

  const customer = getAccountLedgerSync(db, "u1", { hideUpstream: true }).entries;
  assert.deepEqual(customer.map((e) => e.model).sort(), ["glm-5", null], "a legacy row without a combo shows no model");
  assert.ok(customer.every((e) => !("upstreamModel" in e)));
  assert.doesNotMatch(JSON.stringify(customer), /glm-5\.3/);

  const admin = getAccountLedgerSync(db, "u1", {}).entries;
  assert.ok(admin.some((e) => e.model === "glm-5" && e.upstreamModel === "glm-5.3:pre"), "the admin sees both");
});

test("one-pass replacement: no compounding, ordinary words survive", () => {
  const glm = { publicName: "glm-5", ids: pm.hiddenModelIds({ members: ["glm/glm-5.3:pre"], publicName: "glm-5" }), providers: ["glm"] };
  assert.equal(pm.scrubModelIds("max_tokens too large for glm-5.3:pre", glm.ids, glm.publicName, glm.providers), "max_tokens too large for glm-5");
  const kimi = { publicName: "kimi-k2", ids: pm.hiddenModelIds({ members: ["kimi/kimi-k2-0905"], publicName: "kimi-k2" }) };
  assert.equal(pm.scrubModelIds("kimi-k2-0905 does not support tools", kimi.ids, kimi.publicName), "kimi-k2 does not support tools");
  const together = { publicName: "llama", ids: pm.hiddenModelIds({ members: ["together/llama-3.3-70b"], publicName: "llama" }), providers: ["together"] };
  assert.equal(pm.scrubModelIds("tools and json cannot be used together", together.ids, together.publicName, together.providers), "tools and json cannot be used together");
  assert.equal(pm.scrubModelIds("No active credentials for provider: together", together.ids, together.publicName, together.providers), "No active credentials for provider");
  const emb = { publicName: "openai/text-embedding-3-small", ids: pm.hiddenModelIds({ upstream: ["text-embedding-3-small", "openai/text-embedding-3-small"], publicName: "openai/text-embedding-3-small" }) };
  assert.deepEqual(emb.ids, [], "what the customer typed is not hidden from them");
});

test("a top-level error event is rebuilt; ordinary request errors are not mistaken for provider-account ones", () => {
  const ev = pm.maskModelFields({ type: "error", code: "insufficient_quota", message: "You exceeded your current quota, check your billing details", param: null }, OPTS);
  assert.equal(ev.code, "model_unavailable");
  assert.equal(ev.param, undefined);
  assert.doesNotMatch(ev.message, /quota|billing/);
  for (const text of ["Prompt contains forbidden content", "The tool description must mention billing", "maximum quota of tools reached"]) {
    assert.equal(pm.upstreamError(400, text, OPTS).code, "invalid_request", text);
  }
});

test("a Responses error turned into chat text goes through the customer's filter", async () => {
  const { openaiResponsesToOpenAIResponse } = await import("../open-sse/translator/response/openai-responses.js");
  const event = { type: "error", error: { message: "The requested model 'gpt-5.x-codex' does not exist" } };
  const filtered = openaiResponsesToOpenAIResponse(event, { errorTextFilter: () => "Model tạm thời gặp lỗi." });
  assert.equal(filtered.choices[0].delta.content, "[Error] Model tạm thời gặp lỗi.");
  const admin = openaiResponsesToOpenAIResponse(event, {});
  assert.match(admin.choices[0].delta.content, /gpt-5\.x-codex/, "admin keys keep the upstream text");
});

test("ids after a slash, cloud paths, nested prefixes, case and variant suffixes are all scrubbed", () => {
  const gem = { publicName: "pro-max", ids: pm.hiddenModelIds({ members: ["gemini/gemini-2.5-pro"], publicName: "pro-max" }), providers: ["gemini"] };
  assert.equal(
    pm.cleanUpstreamMessage("models/gemini-2.5-pro is not found for API version v1beta", gem),
    "models/pro-max is not found for API version v1beta"
  );
  assert.doesNotMatch(
    pm.cleanUpstreamMessage("Publisher model projects/acme-prod-123/locations/us/publishers/google/models/gemini-2.5-pro was not found", gem),
    /acme-prod|gemini-2\.5/
  );
  assert.equal(pm.scrubModelIds("openrouter/zai/glm-5.3:pre failed", OPTS.ids, "glm-5", ["openrouter", "zai"]), "glm-5 failed");
  assert.equal(pm.scrubModelIds("GLM-5.3:PRE and glm-5.3:pre-0905", OPTS.ids, "glm-5"), "glm-5 and glm-5");
  assert.equal(pm.scrubModelIds("the provider together with the model failed", [], "x", ["together"]), "the provider together with the model failed");
  assert.deepEqual(pm.hiddenModelIds({ upstream: ["gpt-4"], publicName: "gpt-4o" }), ["gpt-4"], "a shorter upstream id is still hidden");
});

test("a stored payload keeps ordinary words that happen to be provider ids", () => {
  const opts = { publicName: "llama", ids: pm.hiddenModelIds({ upstream: ["llama-3.3-70b", "together/llama-3.3-70b"], publicName: "llama" }), providers: ["together"] };
  const out = pm.maskStoredResponse({ stop: ["together"], body: { model: "llama-3.3-70b" } }, opts);
  assert.deepEqual(out.stop, ["together"]);
  assert.equal(out.body.model, "llama");
  const err = pm.maskStoredResponse({ error: "Tool results must be sent together with tool calls", status: 400 }, opts);
  assert.equal(err.error, "Tool results must be sent together with tool calls");
});

test("ordinary words, joined words and stored content survive", () => {
  const auto = { publicName: "glm-5", ids: pm.hiddenModelIds({ members: ["openrouter/auto", "zai/glm-5.3:pre"], publicName: "glm-5" }) };
  assert.ok(!auto.ids.includes("auto"), "a word-like bare id is not hidden");
  assert.equal(pm.scrubModelIds("tool_choice auto is invalid; use semi-auto", auto.ids, "glm-5"), "tool_choice auto is invalid; use semi-auto");
  assert.equal(pm.scrubModelIds("glm-5.3:pre-compatible endpoints only", OPTS.ids, "glm-5"), "glm-5-compatible endpoints only");
  assert.equal(pm.scrubModelIds("glm-5.3:pre_v2 down", OPTS.ids, "glm-5"), "glm-5 down");
  // Line breaks survive; only runs of spaces on a line are tidied.
  assert.equal(pm.cleanUpstreamMessage("bad request:\n\n```\nx  y\n```", OPTS), "bad request:\n\n```\nx y\n```");
  const stored = pm.maskStoredResponse({ input: ["a  b", " 1.50", '{"model":"q"}'], model: "glm-5.3:pre" }, OPTS);
  assert.deepEqual(stored.input, ["a  b", " 1.50", '{"model":"q"}']);
  assert.equal(stored.model, "glm-5");
});
