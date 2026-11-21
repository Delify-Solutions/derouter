// Requested-model figures for the admin usage Overview (spec admin-usage-views):
// the day-blob writer, the background rebuild of older days, and getUsageStats in both
// model views, against a real throwaway SQLite database.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-usage-model-view-"));
// DATA_DIR before the driver is imported; a short retention so a "pruned" day is cheap to make.
process.env.DATA_DIR = tmpDir;
process.env.LOG_RETENTION_DAYS = "10";

const { getAdapter } = await import("../src/lib/db/driver.js");
const usage = await import("../src/lib/db/repos/usageRepo.js");
const { updatePricing } = await import("../src/lib/db/repos/pricingRepo.js");

let db;

const pad = (n) => String(n).padStart(2, "0");
const dateKeyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// Noon (local) N days ago, plus `sec` seconds: one distinct timestamp per request.
function atDaysAgo(days, sec = 0) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(12, 0, sec, 0);
  return d;
}

function readDay(dateKey) {
  const row = db.get(`SELECT data FROM usageDaily WHERE dateKey = ?`, [dateKey]);
  return row ? JSON.parse(row.data) : null;
}
function writeDay(dateKey, day) {
  db.run(`UPDATE usageDaily SET data = ? WHERE dateKey = ?`, [JSON.stringify(day), dateKey]);
}
/** Make a day look like it was recorded before `req` existed. */
function stripReq(dateKey) {
  const day = readDay(dateKey);
  delete day.req;
  writeDay(dateKey, day);
  // A blob without req written outside the request writer: let the next trigger look again.
  usage.invalidateRequestedBackfill();
}

// The same request mix for any day: combo "glm-5" answered by two upstreams, a request with
// no requested model, one with an empty requested model, and token shapes that exercise
// every `||` fall-through of the writer.
function requestsFor(days) {
  return [
    { provider: "zai", model: "glm-5.3:pre", requestedModel: "glm-5", connectionId: "conn-zai", endpoint: "/v1/chat/completions",
      tokens: { prompt_tokens: 100, completion_tokens: 50, cached_tokens: 10 } },
    { provider: "zai", model: "glm-5.3:pre", requestedModel: "glm-5", connectionId: "conn-zai", endpoint: "/v1/chat/completions",
      tokens: { prompt_tokens: 0, input_tokens: 70, completion_tokens: 0, output_tokens: 20, cached_tokens: 0, cache_read_input_tokens: 5 } },
    { provider: "openrouter", model: "glm-5", requestedModel: "glm-5", connectionId: "conn-or", endpoint: "/v1/messages",
      tokens: { prompt_tokens: 30, completion_tokens: 10 } },
    { provider: "openai", model: "gpt-4o", connectionId: "conn-oai", apiKey: "sk-admin-local-key-0001", endpoint: "/v1/chat/completions",
      tokens: { prompt_tokens: 40, completion_tokens: 4 } },
    { provider: "openai", model: "gpt-4o", requestedModel: "", connectionId: "conn-oai", endpoint: "/v1/chat/completions",
      tokens: { prompt_tokens: 7, completion_tokens: 3 } },
  ].map((r, i) => ({ ...r, timestamp: atDaysAgo(days, i).toISOString() }));
}

async function record(list) {
  for (const entry of list) await usage.saveRequestUsage({ ...entry, tokens: { ...entry.tokens } });
}

// Independent oracle: the requested-model byModel figures recomputed from the raw rows of a
// day with the writer's per-field rules.
function oracleByModel(dateKey) {
  const out = {};
  const rows = db.all(`SELECT timestamp, model, tokens, meta, cost, costNanoUsd FROM usageHistory`);
  for (const r of rows) {
    if (dateKeyOf(new Date(r.timestamp)) !== dateKey) continue;
    const t = JSON.parse(r.tokens || "{}");
    const m = JSON.parse(r.meta || "{}");
    const key = m.requestedModel || r.model || "unknown";
    out[key] ||= { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, costNanoUsd: 0 };
    out[key].requests += 1;
    out[key].promptTokens += t.prompt_tokens || t.input_tokens || 0;
    out[key].completionTokens += t.completion_tokens || t.output_tokens || 0;
    out[key].cachedTokens += t.cached_tokens || t.cache_read_input_tokens || 0;
    out[key].costNanoUsd += r.costNanoUsd ? Math.round(r.costNanoUsd) : Math.round((r.cost || 0) * 1e9);
  }
  return out;
}

function pickCounts(map) {
  const out = {};
  for (const [k, v] of Object.entries(map || {})) {
    out[k] = { requests: v.requests, promptTokens: v.promptTokens, completionTokens: v.completionTokens, cachedTokens: v.cachedTokens, costNanoUsd: v.costNanoUsd };
  }
  return out;
}

function sumOf(map, field) {
  return Object.values(map || {}).reduce((s, v) => s + (v[field] || 0), 0);
}

const D_TODAY = dateKeyOf(new Date());
const D2 = dateKeyOf(atDaysAgo(2));
const D3 = dateKeyOf(atDaysAgo(3));
const D8 = dateKeyOf(atDaysAgo(8));
const D12 = dateKeyOf(atDaysAgo(12));

before(async () => {
  db = await getAdapter();
  await updatePricing({
    zai: { "glm-5.3:pre": { input: 1, output: 2 } },
    openrouter: { "glm-5": { input: 3, output: 6 } },
    openai: { "gpt-4o": { input: 2.5, output: 10 } },
  });
});

after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── 5.1 day blob ─────────────────────────────────────────────────────────────

test("a new day records requested-model maps, complete, keyed by the effective requested model", async () => {
  await record(requestsFor(2));
  const day = readDay(D2);
  assert.equal(day.req?.complete, true);

  const byModel = day.req.byModel;
  assert.deepEqual(Object.keys(byModel).sort(), ["glm-5", "gpt-4o"]);
  // the combo answered by two upstreams is one row...
  assert.equal(byModel["glm-5"].requests, 3);
  assert.deepEqual(byModel["glm-5"].providers, { zai: 2, openrouter: 1 });
  // ...and a request with no (or an empty) requested model counts under its upstream model.
  assert.equal(byModel["gpt-4o"].requests, 2);
  // same counter values as the upstream maps
  assert.deepEqual(pickCounts(byModel), oracleByModel(D2));
  assert.equal(sumOf(byModel, "requests"), day.requests);
  assert.equal(sumOf(byModel, "costNanoUsd"), day.costNanoUsd);
  assert.equal(sumOf(byModel, "promptTokens"), day.promptTokens);
  assert.ok(day.costNanoUsd > 0, "pricing seeded, so the costs are real");

  assert.equal(day.req.byAccount["glm-5|conn-zai"].requests, 2);
  assert.equal(day.req.byAccount["glm-5|conn-or"].requests, 1);
  // a key nothing owns keeps its raw identity, like the upstream map; no key = local
  assert.equal(day.req.byApiKey["sk-admin-local-key-0001|gpt-4o"].requests, 1);
  assert.equal(day.req.byApiKey["local-no-key|glm-5"].requests, 3);
  assert.equal(day.req.byEndpoint["/v1/chat/completions|glm-5"].requests, 2);
  assert.equal(day.req.byEndpoint["/v1/messages|glm-5"].requests, 1);
});

test("an existing blob without a complete req gets only its upstream maps updated", async () => {
  const [first, ...rest] = requestsFor(3);
  await record([first]);
  stripReq(D3);
  await record(rest);
  const day = readDay(D3);
  assert.equal(day.req, undefined, "the writer never starts req on an existing day");
  assert.equal(day.requests, 5);
  assert.equal(sumOf(day.byModel, "requests"), 5);
});

// ── 5.2 rebuild ──────────────────────────────────────────────────────────────

test("the rebuild of a day equals what the writer records and a raw recomputation", async () => {
  const written = readDay(D2).req;
  stripReq(D2);
  assert.equal(await usage.rebuildRequestedDay(db, D2, { sliceMs: 60 * 60 * 1000 }), "complete");
  const day = readDay(D2);
  assert.equal(day.req.complete, true);
  assert.deepEqual(day.req, written);
  assert.deepEqual(pickCounts(day.req.byModel), oracleByModel(D2));
  assert.equal(sumOf(day.req.byModel, "requests"), day.requests);
});

test("running the rebuild twice, or after an interrupted run, never counts twice", async () => {
  const before = readDay(D2);
  assert.equal(await usage.rebuildRequestedDay(db, D2), "already", "an already complete day is left alone");
  assert.deepEqual(readDay(D2), before);

  stripReq(D2);
  await usage.scanRequestedDay(db, D2); // interrupted: scanned, never committed
  assert.equal(readDay(D2).req, undefined);
  assert.equal(await usage.rebuildRequestedDay(db, D2), "complete");
  assert.deepEqual(pickCounts(readDay(D2).req.byModel), oracleByModel(D2));

  // The same scan committed twice (another loop finishing first) is still counted once.
  stripReq(D2);
  const scan = await usage.scanRequestedDay(db, D2);
  assert.equal(usage.commitRequestedDaySync(db, scan), "complete");
  assert.equal(usage.commitRequestedDaySync(db, scan), "already");
  assert.deepEqual(pickCounts(readDay(D2).req.byModel), oracleByModel(D2));
});

test("a request recorded between the scan and the commit is counted exactly once", async () => {
  // D3 is incomplete (see above): scan it, record one more request of that day, commit.
  const scan = await usage.scanRequestedDay(db, D3);
  await record([{ provider: "zai", model: "glm-5.3:pre", requestedModel: "glm-5", connectionId: "conn-zai",
    endpoint: "/v1/chat/completions", tokens: { prompt_tokens: 11, completion_tokens: 1 }, timestamp: atDaysAgo(3, 30).toISOString() }]);
  assert.equal(readDay(D3).req, undefined, "the late request did not touch the incomplete req");
  assert.equal(usage.commitRequestedDaySync(db, scan), "complete");

  const day = readDay(D3);
  assert.equal(day.requests, 6);
  assert.equal(day.req.byModel["glm-5"].requests, 4);
  assert.deepEqual(pickCounts(day.req.byModel), oracleByModel(D3));

  // After completion the writer adds to req itself — still once.
  await record([{ provider: "openai", model: "gpt-4o", connectionId: "conn-oai", endpoint: "/v1/chat/completions",
    tokens: { prompt_tokens: 2, completion_tokens: 2 }, timestamp: atDaysAgo(3, 40).toISOString() }]);
  const after = readDay(D3);
  assert.equal(after.requests, 7);
  assert.deepEqual(pickCounts(after.req.byModel), oracleByModel(D3));
});

test("only days whose raw rows are all kept are rebuilt; older days are never marked complete", async () => {
  await record(requestsFor(8));
  await record(requestsFor(12));
  stripReq(D8);
  stripReq(D12);

  const pending = usage.listRequestedPendingDaysSync(db);
  assert.ok(pending.includes(D8), "a day inside retention (with the one-day margin) is pending");
  assert.ok(!pending.includes(D12), "a day past retention is not");

  // Even a direct commit refuses a day behind the cut-off: rows may have been pruned.
  const scan = await usage.scanRequestedDay(db, D12);
  assert.equal(usage.commitRequestedDaySync(db, scan), "out-of-retention");
  assert.equal(readDay(D12).req, undefined);

  // The background loop completes the pending days, newest first, then reports idle.
  await usage.scheduleRequestedBackfill(db);
  assert.equal(readDay(D8).req?.complete, true);
  assert.deepEqual(pickCounts(readDay(D8).req.byModel), oracleByModel(D8));
  assert.equal(readDay(D12).req, undefined);
  assert.equal(usage.getRequestedBackfillProgress().running, false);
  assert.deepEqual(usage.listRequestedPendingDaysSync(db), []);
});

// ── 5.3 getUsageStats ────────────────────────────────────────────────────────

function liveFields(s) {
  return {
    totalRequests: s.totalRequests,
    totalPromptTokens: s.totalPromptTokens,
    totalCompletionTokens: s.totalCompletionTokens,
    totalCachedTokens: s.totalCachedTokens,
    totalCostNanoUsd: s.totalCostNanoUsd,
    byProvider: s.byProvider,
    last10Minutes: s.last10Minutes,
    recentRequests: s.recentRequests,
  };
}

test("today / 24h: both views have identical totals; the combo is one requested row", async () => {
  // Seconds ago, so the rows are in "today" and the last-10-minutes window.
  const now = Date.now();
  await record(requestsFor(0).map((r, i) => ({ ...r, timestamp: new Date(now - (5 - i) * 1000).toISOString() })));

  for (const period of ["today", "24h"]) {
    const up = await usage.getUsageStats(period, { modelView: "upstream" });
    const rq = await usage.getUsageStats(period, { modelView: "requested" });
    assert.deepEqual(liveFields(rq), liveFields(up), period);
    assert.equal(rq.modelView, "requested");
    assert.equal(rq.requestedPartial, false);

    assert.equal(rq.byModel["glm-5"].requests, 3);
    assert.deepEqual(rq.byModel["glm-5"].providers.map((p) => [p.id, p.requests]), [["zai", 2], ["openrouter", 1]]);
    assert.equal(rq.byModel["glm-5"].rawModel, "glm-5");
    assert.equal(rq.byModel["gpt-4o"].requests, 2);
    assert.equal(sumOf(rq.byModel, "requests"), rq.totalRequests);
    assert.equal(sumOf(rq.byModel, "costNanoUsd"), rq.totalCostNanoUsd);
    // the upstream view still splits the combo by upstream model
    assert.equal(up.byModel["glm-5.3:pre (zai)"].requests, 2);
    assert.equal(up.byModel["glm-5 (openrouter)"].requests, 1);
    assert.equal(up.modelView, undefined, "the upstream output keeps its historical shape");

    // Key table by (key, requested model)
    assert.equal(rq.byApiKey["local-no-key|glm-5"].requests, 3);
    assert.equal(rq.byApiKey["sk-admin-local-key-0001|gpt-4o"].requests, 1);
    assert.equal(rq.byApiKey["sk-admin-local-key-0001|gpt-4o"].apiKeyMasked, "sk-admin***");
  }
});

test("daily periods: identical totals in both views; a day past retention is reported", async () => {
  for (const period of ["7d", "30d", "60d"]) {
    const up = await usage.getUsageStats(period, { modelView: "upstream" });
    const rq = await usage.getUsageStats(period, { modelView: "requested" });
    assert.deepEqual(liveFields(rq), liveFields(up), period);
    assert.equal(sumOf(rq.byModel, "requests"), rq.totalRequests, period);
    assert.equal(sumOf(rq.byModel, "costNanoUsd"), rq.totalCostNanoUsd, period);
    assert.equal(sumOf(rq.byAccount, "requests"), sumOf(up.byAccount, "requests"), period);
    assert.equal(sumOf(rq.byApiKey, "requests"), sumOf(up.byApiKey, "requests"), period);
    assert.equal(sumOf(rq.byEndpoint, "requests"), sumOf(up.byEndpoint, "requests"), period);
  }

  // 7 days: every day in range has requested figures.
  const week = await usage.getUsageStats("7d", { modelView: "requested" });
  assert.equal(week.requestedPartial, false);
  // today 3 + D2 3 + D3 4 (one added between scan and commit)
  assert.equal(week.byModel["glm-5"].requests, 10);

  // 30 days include D12, which could not be rebuilt: it falls back to its upstream models.
  const month = await usage.getUsageStats("30d", { modelView: "requested" });
  assert.equal(month.requestedPartial, true);
  assert.equal(month.requestedSince, D8);
  // D12's three glm-5 requests appear under their upstream names.
  assert.equal(month.byModel["glm-5"].requests, 10 + 3 + 1, "today, D2, D3, D8 requested + D12 openrouter fallback");
  assert.equal(month.byModel["glm-5.3:pre"].requests, 2, "D12's zai requests, by upstream model");
  assert.deepEqual(month.byModel["glm-5.3:pre"].providers.map((p) => p.id), ["zai"]);
});

test("the requested view starts the rebuild of incomplete days in the background", async () => {
  stripReq(D_TODAY);
  await usage.getUsageStats("7d", { modelView: "requested" });
  // Wait for the loop the read started.
  await usage.scheduleRequestedBackfill(db);
  assert.equal(readDay(D_TODAY).req?.complete, true);
  assert.deepEqual(pickCounts(readDay(D_TODAY).req.byModel), oracleByModel(D_TODAY));
  assert.ok(usage.getRequestedBackfillProgress().generation > 0);
});
