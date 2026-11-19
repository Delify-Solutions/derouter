// DeepAI Code on /dashboard/quota: the Theos allowance, the plan, free vs metered models, the
// "out of it" errors that lock a model, and the forced catalog refresh.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "deepai-usage-test-"));

const client = await import("../open-sse/services/deepaiClient.js");
const { deepaiUsageFromTheos, deepaiModelSummary, getDeepAIUsage } = await import("../open-sse/services/usage/deepai.js");
const { getUsageForProvider } = await import("../open-sse/services/usage.js");
const { parseDeepAIError } = await import("../open-sse/executors/deepai.js");
const deepaiRegistry = (await import("../open-sse/providers/registry/deepai.js")).default;
const { MAX_RATE_LIMIT_COOLDOWN_MS } = await import("../open-sse/config/errorConfig.js");

const json = (body, status = 200) => ({ body, status });

// A loopback DeepAI (DEEPAI_LOCAL_TEST_ORIGIN): proxyAwareFetch uses its own transport, so
// replacing globalThis.fetch would not intercept it.
let handler = () => json({}, 404);
const server = http.createServer((req, res) => {
  const { body, status } = handler(req.url);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.DEEPAI_LOCAL_TEST_ORIGIN = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

async function withFetch(next, fn) {
  handler = next;
  try { await fn(); } finally { handler = () => json({}, 404); }
}

test("registry flags deepai for the quota page", () => {
  assert.equal(deepaiRegistry.features?.usage, true);
});

test("Theos bar: balance of the granted allowance, reset at refresh_at", () => {
  const out = deepaiUsageFromTheos({ enabled: true, balance: "250", granted: "1000", refresh_at: "2026-11-21T00:00:00Z" }, { isPro: false });
  assert.equal(out.plan, "DeepAI Free");
  const q = out.quotas.Theos;
  assert.equal(q.total, 1000);
  assert.equal(q.used, 750);
  assert.equal(q.remaining, 250);
  assert.equal(q.resetAt, "2026-11-21T00:00:00.000Z");
  // numbers work too; a balance above the grant reads as a full bar
  const over = deepaiUsageFromTheos({ enabled: true, balance: 1500, granted: 1000 }, { isPro: true }).quotas.Theos;
  assert.equal(over.total, 1500);
  assert.equal(over.used, 0);
  assert.equal(deepaiUsageFromTheos({ enabled: true, balance: "5" }).plan, "DeepAI");
});

test("Theos without a grant size is stated as text; disabled and malformed bodies are messages", () => {
  const credit = deepaiUsageFromTheos({ enabled: true, balance: "40" });
  assert.equal(credit.quotas, undefined);
  assert.match(credit.message, /Còn 40 Theos/);
  assert.match(deepaiUsageFromTheos({ enabled: true, balance: "0" }).message, /Còn 0 Theos/);
  assert.match(deepaiUsageFromTheos({ enabled: false }).message, /không có hạn mức/);
  assert.match(deepaiUsageFromTheos({ enabled: true, balance: "abc" }).message, /không có số dư/);
  assert.match(deepaiUsageFromTheos(null).message, /không trả về/);
});

test("catalog keeps per-request price and Pro flag; free vs metered", () => {
  const list = client.normalizeDeepAIModels({
    models: [
      { id: "glm-5.3-flash", name: "GLM", theosPerRequest: "0" },
      { id: "muse-ember", name: "Muse", theosPerRequest: "12", premier: true },
      { id: "deepai-cyber", name: "Cyber", theosPerRequest: "bad" },
    ],
  });
  assert.equal(list[0].theosPerRequest, "0");
  assert.equal(list[1].premier, true);
  assert.equal(list[2].theosPerRequest, undefined);
  assert.equal(client.isDeepAIModelMetered(list[0]), false);
  assert.equal(client.isDeepAIModelMetered(list[1]), true);
  assert.equal(client.isDeepAIModelMetered(list[2]), null);
  assert.deepEqual(deepaiModelSummary(list), { free: ["glm-5.3-flash"], metered: ["muse-ember (12)"] });
  assert.equal(deepaiModelSummary([]), null);
});

test("exhausted answers lock the model for the longest cooldown; heavy load does not", () => {
  const before = Date.now();
  const daily = parseDeepAIError(429, JSON.stringify({ error: { code: "rate_limit_exceeded", message: "Daily limit reached for this model" } }));
  assert.equal(daily.status, 429);
  assert.match(daily.message, /rate_limit_exceeded: Daily limit reached/);
  assert.ok(daily.resetsAtMs >= before + MAX_RATE_LIMIT_COOLDOWN_MS);
  const theos = parseDeepAIError(402, JSON.stringify({ code: "theos_exhausted", message: "Your Theos allowance is used up" }));
  assert.ok(theos.resetsAtMs > before);
  assert.ok(parseDeepAIError(429, "Too many requests today").resetsAtMs > before);
  const busy = parseDeepAIError(429, JSON.stringify({ error: { message: "Too many requests, slow down" } }));
  assert.equal(busy.resetsAtMs, undefined);
  assert.equal(busy.message, "Too many requests, slow down");
  assert.equal(parseDeepAIError(500, "").message, "HTTP 500");
});

test("getDeepAIUsage: live plan wins, catalog summary attached, stored flag is the fallback", async () => {
  client.resetDeepAIStateForTests();
  const seen = [];
  await withFetch((u) => {
    seen.push(u);
    if (u.endsWith("/theos")) return json({ enabled: true, balance: "100", granted: "400", refresh_at: "2026-11-21T00:00:00Z" });
    if (u === "/get_usage_summary") return json({ is_authenticated: true, is_pro: true });
    if (u.endsWith("/models")) return json({ models: [{ id: "glm-5.3-flash", name: "GLM", theosPerRequest: "0" }, { id: "muse-ember", name: "M", theosPerRequest: "3" }] });
    return json({}, 404);
  }, async () => {
    const out = await getDeepAIUsage("key-u1", { isPro: false });
    assert.equal(out.plan, "DeepAI Pro");
    assert.equal(out.quotas.Theos.remaining, 100);
    assert.deepEqual(out.deepaiModels, { free: ["glm-5.3-flash"], metered: ["muse-ember (3)"] });
  });
  // /get_usage_summary lives at the API origin, not under /deepai_code (app requestDeepAIJson)
  assert.ok(seen.includes("/deepai_code/theos"));
  assert.ok(seen.includes("/get_usage_summary"));
  assert.ok(!seen.includes("/deepai_code/get_usage_summary"));

  client.resetDeepAIStateForTests();
  await withFetch((u) => {
    if (u.endsWith("/theos")) return json({ enabled: true, balance: "1" });
    return json({ error: "nope" }, 500);
  }, async () => {
    const out = await getDeepAIUsage("key-u2", { isPro: false });
    assert.equal(out.plan, "DeepAI Free", "stored sign-in flag when the entitlement call fails");
    assert.equal(out.deepaiModels, undefined, "no summary from the bundled fallback catalog");
  });
});

test("quota dispatcher routes deepai and reports a missing key", async () => {
  const out = await getUsageForProvider({ provider: "deepai", authType: "oauth" });
  assert.match(out.message, /chưa đăng nhập/);
});

test("forced refresh skips the 5-minute catalog cache", async () => {
  client.resetDeepAIStateForTests();
  let calls = 0;
  await withFetch(() => { calls += 1; return json({ models: [{ id: `m-${calls}`, name: "x" }] }); }, async () => {
    const first = await client.resolveDeepAIModels({ apiKey: "key-r" });
    const cached = await client.resolveDeepAIModels({ apiKey: "key-r" });
    const forced = await client.resolveDeepAIModels({ apiKey: "key-r" }, { forceRefresh: true });
    assert.equal(first.models[0].id, "m-1");
    assert.equal(cached.source, "cache");
    assert.equal(forced.source, "live");
    assert.equal(forced.models[0].id, "m-2");
    assert.equal(calls, 2);
  });
});

test("the quota read shares the check-in's single /theos call", async () => {
  client.resetDeepAIStateForTests();
  let theos = 0;
  const nonce = (n) => String(n).repeat(32).slice(0, 32); // 32 hex chars, as DeepAI issues
  await withFetch((u) => {
    if (u.endsWith("/theos")) {
      theos += 1;
      return json({ enabled: true, balance: "7", granted: "10", check_in: { nonce: nonce(theos), seconds: 600 } });
    }
    return json({}, 404);
  }, async () => {
    // a chat check-in and a quota read at the same moment: one /theos request
    const [, allowance] = await Promise.all([client.ensureDeepAICheckIn("key-sf"), client.fetchDeepAIAllowance("key-sf")]);
    assert.equal(theos, 1);
    assert.equal(allowance.balance, "7");
    assert.equal(client.currentCheckInNonce("key-sf"), nonce(1), "the renewed nonce is kept");
    // a second read within 30 s reuses that answer
    assert.equal((await client.fetchDeepAIAllowance("key-sf")).balance, "7");
    assert.equal(theos, 1);
    // a chat request with a fresh nonce does not call /theos again
    await client.ensureDeepAICheckIn("key-sf");
    assert.equal(theos, 1);
  });
});

test("a failed balance read is not shown as the current balance", async () => {
  client.resetDeepAIStateForTests();
  let ok = true;
  await withFetch((u) => {
    if (u.endsWith("/theos")) return ok ? json({ enabled: true, balance: "250", granted: "1000" }) : json({ error: "down" }, 503);
    return json({}, 404);
  }, async () => {
    assert.equal((await client.fetchDeepAIAllowance("key-st")).balance, "250");
    ok = false;
    const realNow = Date.now;
    Date.now = () => realNow() + 31_000; // past the freshness window
    try {
      assert.equal(await client.fetchDeepAIAllowance("key-st"), null);
      // and during the retry backoff that follows
      assert.equal(await client.fetchDeepAIAllowance("key-st"), null);
    } finally {
      Date.now = realNow;
    }
  });
});

test("an exhausted DeepAI answer becomes a per-model lock through the error pipeline", async () => {
  const { parseUpstreamError } = await import("../open-sse/utils/error.js");
  const { DeepAIExecutor } = await import("../open-sse/executors/deepai.js");
  const { buildModelLockUpdate } = await import("../open-sse/services/accountFallback.js");
  const response = new Response(JSON.stringify({ error: { message: "Daily limit reached" } }), { status: 429 });
  const { statusCode, resetsAtMs } = await parseUpstreamError(response, new DeepAIExecutor());
  assert.equal(statusCode, 429);
  assert.ok(resetsAtMs > Date.now() + MAX_RATE_LIMIT_COOLDOWN_MS - 5000);
  const lock = buildModelLockUpdate("glm-5.3-flash", resetsAtMs - Date.now());
  const [key] = Object.keys(lock);
  assert.match(key, /glm-5\.3-flash/, "the lock names the model, not the whole account");
});
