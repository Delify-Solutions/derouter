// Hardening of the requested-model usage figures (verify round 1 of admin-usage-model-view):
//   - model names a client chooses ("__proto__", "constructor", …) are ordinary names in
//     every map: counted correctly, never written onto Object.prototype;
//   - a day whose raw rows were partly deleted is never marked complete;
//   - the Providers summary reports each provider's last request;
//   - the stats route never serves requested figures from before a rebuilt day.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-usage-hardening-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const usage = await import("../src/lib/db/repos/usageRepo.js");
const rollup = await import("../src/lib/db/repos/usageRollup.js");
const { updatePricing } = await import("../src/lib/db/repos/pricingRepo.js");

let db;
const NAMES = ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty"];
const ADMIN_KEY = "sk-admin-hardening-key-0001";

const pad = (n) => String(n).padStart(2, "0");
const dateKeyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function atDaysAgo(days, sec = 0) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(12, 0, sec, 0);
  return d;
}
const readDay = (k) => JSON.parse(db.get(`SELECT data FROM usageDaily WHERE dateKey = ?`, [k]).data);
function stripReq(k) {
  const day = readDay(k);
  delete day.req;
  db.run(`UPDATE usageDaily SET data = ? WHERE dateKey = ?`, [JSON.stringify(day), k]);
  usage.invalidateRequestedBackfill();
}
const own = (obj, key) => (Object.hasOwn(obj, key) ? obj[key] : undefined);

function assertPrototypeClean() {
  const probe = {};
  for (const field of ["requests", "rawModel", "promptTokens", "costNanoUsd", "providers", "model", "input", "lastUsed"]) {
    assert.equal(probe[field], undefined, `Object.prototype.${field} must stay undefined`);
  }
  assert.equal(Object.getPrototypeOf(probe), Object.prototype);
  assert.equal(typeof ({}).toString, "function");
}

before(async () => {
  db = await getAdapter();
  await updatePricing({ p1: { "m-up": { input: 1, output: 2 } } });
});

after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── C1: client-chosen model names ────────────────────────────────────────────

const TODAY = dateKeyOf(new Date());

test("requested model names like __proto__ are counted in the write path and never pollute Object.prototype", async () => {
  const now = Date.now();
  let i = 0;
  for (const name of NAMES) {
    // A denied request is recorded with whatever model the client sent.
    await usage.saveRequestUsage({
      provider: "p1", model: "m-up", requestedModel: name, connectionId: "conn-1", apiKey: ADMIN_KEY,
      endpoint: "/v1/chat/completions", tokens: { prompt_tokens: 10, completion_tokens: 5 },
      timestamp: new Date(now - (20 - i++) * 1000).toISOString(),
    });
  }
  // An upstream model name with no provider is a bare key in the upstream maps.
  await usage.saveRequestUsage({
    provider: null, model: "__proto__", connectionId: "conn-2", endpoint: "/v1/chat/completions",
    tokens: { prompt_tokens: 1, completion_tokens: 1 }, timestamp: new Date(now - 2000).toISOString(),
  });
  usage.trackPendingRequest("__proto__", "", "conn-1", true);
  usage.trackPendingRequest("constructor", "", "conn-1", true);
  usage.trackPendingRequest("__proto__", "", "conn-1", false);
  assertPrototypeClean();

  const day = readDay(TODAY);
  assert.equal(day.req.complete, true);
  for (const name of NAMES) {
    assert.ok(Object.hasOwn(day.req.byModel, name), `${name} is an own key`);
    // "__proto__" also holds the request with no requested model served by "__proto__"
    assert.equal(own(day.req.byModel, name).requests, name === "__proto__" ? 2 : 1, name);
    assert.equal(own(day.req.byModel, name).rawModel, name);
    assert.equal(own(day.req.byApiKey, `${ADMIN_KEY}|${name}`).requests, 1, name);
  }
  // the bare upstream key "__proto__" (no provider) plus the request without one
  assert.equal(own(day.byModel, "__proto__").requests, 1);
  assert.equal(own(day.req.byModel, "__proto__").requests, 2, "requested __proto__ + the upstream fallback");
  assert.equal(day.requests, NAMES.length + 1);
});

test("the rebuild counts those names exactly like the writer", async () => {
  const written = readDay(TODAY).req;
  stripReq(TODAY);
  assert.equal(await usage.rebuildRequestedDay(db, TODAY), "complete");
  assert.deepEqual(readDay(TODAY).req, written);
  assertPrototypeClean();
});

test("the read paths count those names as rows of their own", async () => {
  for (const period of ["today", "7d"]) {
    const stats = await usage.getUsageStats(period, { modelView: "requested" });
    for (const name of NAMES) {
      assert.ok(Object.hasOwn(stats.byModel, name), `${period}: ${name}`);
      const expected = name === "__proto__" ? 2 : 1;
      assert.equal(stats.byModel[name].requests, expected, `${period}: ${name}`);
      assert.equal(stats.byModel[name].rawModel, name);
    }
    const sum = Object.values(stats.byModel).reduce((s, r) => s + r.requests, 0);
    assert.equal(sum, NAMES.length + 1, period);
    const up = await usage.getUsageStats(period, { modelView: "upstream" });
    assert.equal(up.byModel["__proto__"]?.requests, 1, `${period}: upstream bare key`);
    // the API body is JSON: the names survive serialisation as plain keys
    const body = JSON.parse(JSON.stringify(stats));
    assert.equal(own(body.byModel, "__proto__").requests, 2);
  }

  // The Users tab and the key summary group by the requested model too.
  const owners = await usage.getUsageByOwner({ startDate: new Date(Date.now() - 3600_000).toISOString() });
  // A raw key no apiKeys row owns is listed under "Deleted or unknown keys".
  const owner = owners.find((o) => o.kind === "unknown");
  for (const name of NAMES) assert.equal(owner.byModel.find((m) => m.model === name)?.requests, 1, `owner byModel ${name}`);
  const keySummary = await usage.getKeyUsageSummary(ADMIN_KEY, { startDate: new Date(Date.now() - 3600_000).toISOString() });
  for (const name of NAMES) assert.equal(keySummary.items.find((m) => m.model === name)?.requests, 1, `key summary ${name}`);
  assertPrototypeClean();
});

// ── C2: raw rows partly deleted ──────────────────────────────────────────────

const D2 = dateKeyOf(atDaysAgo(2));
const D3 = dateKeyOf(atDaysAgo(3));
const KEEP = "sk-admin-keep-key-0000001";
const WIPE = "sk-admin-wipe-key-0000001";

async function fourRequests(days) {
  for (let i = 0; i < 4; i++) {
    await usage.saveRequestUsage({
      provider: "p1", model: "m-up", requestedModel: "combo-a", connectionId: "conn-1",
      apiKey: i < 2 ? KEEP : WIPE, endpoint: "/v1/chat/completions",
      tokens: { prompt_tokens: 10 + i, completion_tokens: 5 }, timestamp: atDaysAgo(days, i).toISOString(),
    });
  }
}

test("a day whose raw rows were partly wiped before the rebuild is marked unrecoverable, not complete", async () => {
  await fourRequests(2);
  stripReq(D2); // recorded before the requested maps existed
  const wiped = await usage.deleteKeyUsageHistory(WIPE);
  assert.equal(wiped.history, 2);

  assert.equal(await usage.rebuildRequestedDay(db, D2), "unrecoverable");
  const day = readDay(D2);
  assert.equal(day.req.complete, false);
  assert.equal(day.req.unrecoverable, true);
  assert.equal(day.req.counted, 2);
  assert.equal(day.req.expected, 4);
  assert.equal(day.requests, 4, "the upstream maps are not adjusted by a wipe");
  // never scanned again, and the writer does not start filling it
  assert.ok(!usage.listRequestedPendingDaysSync(db).includes(D2));
  assert.equal(await usage.rebuildRequestedDay(db, D2), "already");

  const stats = await usage.getUsageStats("7d", { modelView: "requested" });
  const up = await usage.getUsageStats("7d", { modelView: "upstream" });
  const sumOf = (s) => Object.values(s.byModel).reduce((acc, r) => acc + r.requests, 0);
  // (totalRequests counts provider rows only, so the provider-less request is compared
  // through the upstream Model rows instead)
  assert.equal(sumOf(stats), sumOf(up), "Model rows still add up to the same total as the upstream view");
  assert.equal(stats.totalRequests, up.totalRequests);
  assert.equal(stats.byModel["m-up"].requests, 4, "the day falls back to its upstream model");
  assert.equal(stats.requestedPartial, true);
  assert.deepEqual(stats.upstreamOnlyDays, [D2]);
  assert.equal(stats.requestedSince, TODAY, "the requested run starts after the fallback day");
  assert.equal(stats.upstreamOnlyIsPrefix, true);
});

test("a day completed before a wipe keeps counting the wiped rows, like its upstream maps", async () => {
  await fourRequests(3);
  assert.equal(readDay(D3).req.complete, true);
  await usage.deleteKeyUsageHistory(WIPE);
  const day = readDay(D3);
  assert.equal(day.req.complete, true);
  assert.equal(own(day.req.byModel, "combo-a").requests, 4);
  assert.equal(day.requests, 4);
});

test("a fallback day between requested days is named, not hidden behind 'before <date>'", async () => {
  // D3 complete, D2 unrecoverable, today complete: D2 is not a prefix of the range.
  const stats = await usage.getUsageStats("7d", { modelView: "requested" });
  assert.deepEqual(stats.upstreamOnlyDays, [D2]);
  assert.equal(stats.requestedSince, TODAY);
  assert.equal(stats.upstreamOnlyIsPrefix, false, "D3 has requested figures before requestedSince");
});

test("once every day is resolved, a trigger does not list the days again until invalidated", async () => {
  await usage.scheduleRequestedBackfill(db);
  const day = readDay(D3);
  delete day.req;
  db.run(`UPDATE usageDaily SET data = ? WHERE dateKey = ?`, [JSON.stringify(day), D3]);
  await usage.scheduleRequestedBackfill(db);
  assert.equal(readDay(D3).req, undefined, "no listing: the flag says every day is resolved");
  usage.invalidateRequestedBackfill();
  await usage.scheduleRequestedBackfill(db);
  // D3 lost two raw rows to the wipe above, so it can only be unrecoverable now.
  assert.equal(readDay(D3).req.unrecoverable, true);
});

// ── W2: provider last used ───────────────────────────────────────────────────

test("the provider summary reports the last request, from raw rows and from the rollup", async () => {
  const range = { startDate: atDaysAgo(4).toISOString(), endDate: new Date().toISOString() };
  const newest = db.get(`SELECT MAX(timestamp) AS t FROM usageHistory WHERE provider = 'p1'`).t;

  const raw = await usage.getProviderUsageSummary({ ...range, useRollup: false });
  assert.equal(raw.items.find((i) => i.provider === "p1").lastUsed, newest);

  // Roll the complete hours, then make them look rolled before lastTs existed.
  await rollup.scheduleRollup(db);
  const count = (table, where = "") => db.get(`SELECT COUNT(*) AS c FROM ${table} ${where}`).c;
  const before = {
    provider: count("usageRollupProvider"), key: count("usageRollupKey"), peak: count("usageRollupOwnerPeak"),
    watermark: rollup.getWatermarkMs(db),
  };
  assert.ok(before.provider > 1 && before.key > 0 && before.peak > 0, "several hours rolled");
  assert.equal(count("usageRollupProvider", "WHERE lastTs IS NULL"), 0, "new rolls write lastTs");
  db.run(`UPDATE usageRollupProvider SET lastTs = NULL`);

  // Filled in place, one hour per step: no rollup row is thrown away, the Users tab's key and
  // owner-peak rollups and the watermark survive.
  await rollup.scheduleProviderLastTsBackfill(db);
  assert.equal(count("usageRollupProvider", "WHERE lastTs IS NULL"), 0);
  assert.deepEqual({
    provider: count("usageRollupProvider"), key: count("usageRollupKey"), peak: count("usageRollupOwnerPeak"),
    watermark: rollup.getWatermarkMs(db),
  }, before);
  for (const r of db.all(`SELECT hour, provider, lastTs FROM usageRollupProvider`)) {
    const from = `${r.hour}:00:00.000Z`;
    const to = new Date(Date.parse(from) + 3600_000).toISOString();
    const raw = db.get(`SELECT MAX(timestamp) AS t FROM usageHistory WHERE timestamp >= ? AND timestamp < ? AND COALESCE(NULLIF(provider, ''), 'unknown') = ?`, [from, to, r.provider]).t;
    assert.equal(r.lastTs, raw, `${r.hour} ${r.provider}`);
  }

  // Once per process: after a complete pass a call does nothing.
  db.run(`UPDATE usageRollupProvider SET lastTs = NULL`);
  await rollup.scheduleProviderLastTsBackfill(db);
  assert.equal(count("usageRollupProvider", "WHERE lastTs IS NULL"), before.provider);
  // A single step fills exactly one hour, the newest.
  const filled = rollup.backfillProviderLastTsStepSync(db);
  assert.equal(filled, db.get(`SELECT MAX(hour) AS h FROM usageRollupProvider`).h);
  assert.equal(count("usageRollupProvider", "WHERE lastTs IS NULL"), before.provider - db.get(`SELECT COUNT(*) AS c FROM usageRollupProvider WHERE hour = ?`, [filled]).c);

  // While hours are unfilled, the summaries stay exact (the newest unfilled hour is read raw).
  const rolled = await usage.getProviderUsageSummary(range);
  assert.equal(rolled.items.find((i) => i.provider === "p1").lastUsed, newest);
  // only the rollup: an older range ending before today's rows
  const oldRange = { startDate: atDaysAgo(4).toISOString(), endDate: atDaysAgo(1).toISOString() };
  const oldNewest = db.get(`SELECT MAX(timestamp) AS t FROM usageHistory WHERE provider = 'p1' AND timestamp <= ?`, [oldRange.endDate]).t;
  assert.equal((await usage.getProviderUsageSummary(oldRange)).items.find((i) => i.provider === "p1").lastUsed, oldNewest);
  assert.equal((await usage.getProviderUsageSummary({ ...oldRange, useRollup: false })).items.find((i) => i.provider === "p1").lastUsed, oldNewest);
  // ...and with every hour unfilled
  db.run(`UPDATE usageRollupProvider SET lastTs = NULL`);
  assert.equal((await usage.getProviderUsageSummary(oldRange)).items.find((i) => i.provider === "p1").lastUsed, oldNewest);
});

// ── W1 (round 2): fractional token counts ────────────────────────────────────

test("a fractional token count is rebuilt exactly like the writer adds it", async () => {
  const D6 = dateKeyOf(atDaysAgo(6));
  await usage.saveRequestUsage({
    provider: "p1", model: "m-up", requestedModel: "combo-frac", connectionId: "conn-1", endpoint: "/v1/chat/completions",
    tokens: { prompt_tokens: 3.5, completion_tokens: 1.25, cached_tokens: 0.5 }, timestamp: atDaysAgo(6).toISOString(),
  });
  await usage.saveRequestUsage({
    provider: "p1", model: "m-up", requestedModel: "combo-frac", connectionId: "conn-1", endpoint: "/v1/chat/completions",
    tokens: { prompt_tokens: 2, completion_tokens: 1 }, timestamp: atDaysAgo(6, 1).toISOString(),
  });
  const written = readDay(D6).req;
  assert.equal(own(written.byModel, "combo-frac").promptTokens, 5.5);
  stripReq(D6);
  assert.equal(await usage.rebuildRequestedDay(db, D6), "complete", "not marked unrecoverable");
  const day = readDay(D6);
  assert.deepEqual(day.req, written);
  assert.equal(day.promptTokens, 5.5);
});

test("the reconciliation tolerance absorbs summation order only, never a real difference", async () => {
  // Many fractional counts whose float sum depends on the order of addition.
  const D9 = dateKeyOf(atDaysAgo(9));
  const values = [0.1, 0.2, 0.3, 0.7, 1.1, 2.3, 0.05, 0.15, 3.3, 0.9];
  for (let i = 0; i < values.length; i++) {
    await usage.saveRequestUsage({
      provider: "p1", model: "m-up", requestedModel: "combo-float", connectionId: "conn-1", endpoint: "/v1/chat/completions",
      tokens: { prompt_tokens: values[i], completion_tokens: values[values.length - 1 - i], cached_tokens: values[i] / 3 },
      timestamp: atDaysAgo(9, i).toISOString(),
    });
  }
  stripReq(D9);
  assert.equal(await usage.rebuildRequestedDay(db, D9), "complete");

  // An integer-only day off by a single token is still caught.
  const D10 = dateKeyOf(atDaysAgo(10));
  for (let i = 0; i < 3; i++) {
    await usage.saveRequestUsage({
      provider: "p1", model: "m-up", requestedModel: "combo-int", connectionId: "conn-1", endpoint: "/v1/chat/completions",
      tokens: { prompt_tokens: 1000 + i, completion_tokens: 7 }, timestamp: atDaysAgo(10, i).toISOString(),
    });
  }
  stripReq(D10);
  const day = readDay(D10);
  day.promptTokens += 1;
  db.run(`UPDATE usageDaily SET data = ? WHERE dateKey = ?`, [JSON.stringify(day), D10]);
  assert.equal(await usage.rebuildRequestedDay(db, D10), "unrecoverable");
});

test("unfilled provider hours are read once per hour for all providers, newest hour per provider", async () => {
  const base = new Date(atDaysAgo(8));
  base.setUTCHours(0, 0, 0, 0);
  const at = (h, m) => new Date(base.getTime() + h * 3600_000 + m * 60_000).toISOString();
  const rows = [
    ["pA", at(10, 5)], ["pA", at(13, 40)], // pA's newest hour: 13
    ["pB", at(11, 20)],                     // pB's newest hour: 11
    ["pC", at(13, 10)], ["pC", at(9, 50)],  // pC shares hour 13 with pA
  ];
  for (const [provider, timestamp] of rows) {
    await usage.saveRequestUsage({
      provider, model: "m-x", connectionId: `conn-${provider}`, endpoint: "/v1/chat/completions",
      tokens: { prompt_tokens: 1, completion_tokens: 1 }, timestamp,
    });
  }
  // Those hours were rolled before the rows were back-dated into them: roll them again.
  db.transaction(() => rollup.invalidateRollupFromSync(db, at(0, 0)));
  await rollup.scheduleRollup(db);
  // ...and make them look rolled before lastTs existed (the backfill already ran in this
  // process, so nothing fills them in the background).
  db.run(`UPDATE usageRollupProvider SET lastTs = NULL WHERE provider IN ('pA', 'pB', 'pC')`);

  const range = { startDate: at(0, 0), endDate: at(23, 59) };
  const { items } = await usage.getProviderUsageSummary(range);
  const lastOf = (p) => items.find((i) => i.provider === p)?.lastUsed;
  assert.equal(lastOf("pA"), at(13, 40));
  assert.equal(lastOf("pB"), at(11, 20));
  assert.equal(lastOf("pC"), at(13, 10));
  // the same answer as the raw rows
  const raw = await usage.getProviderUsageSummary({ ...range, useRollup: false });
  for (const p of ["pA", "pB", "pC"]) assert.equal(lastOf(p), raw.items.find((i) => i.provider === p).lastUsed, p);
  // one grouped read serves every provider of an hour
  const hour13 = rollup.hourLastTsByProviderSync(db, at(13, 0).slice(0, 13));
  assert.equal(hour13.get("pA"), at(13, 40));
  assert.equal(hour13.get("pC"), at(13, 10));
  assert.equal(hour13.has("pB"), false);
});

// ── W4: the stats route and rebuilt days ─────────────────────────────────────

test("after the rebuild finishes, the route answers with every rebuilt day, cache or not", async () => {
  register("./helpers/src-alias-hook.mjs", import.meta.url);
  register(
    "data:text/javascript,export async function resolve(s, c, next) { return next(s === 'next/server' ? 'next/server.js' : s, c); }",
    import.meta.url
  );
  const { GET } = await import("../src/app/api/usage/stats/route.js");
  const call = async () => (await GET(new Request("http://localhost/api/usage/stats?period=7d&modelView=requested"))).json();

  // A day recorded before the requested maps (complete data, so it can be rebuilt).
  const D5 = dateKeyOf(atDaysAgo(5));
  await usage.saveRequestUsage({
    provider: "p1", model: "m-up", requestedModel: "combo-b", connectionId: "conn-1", endpoint: "/v1/chat/completions",
    tokens: { prompt_tokens: 3, completion_tokens: 3 }, timestamp: atDaysAgo(5).toISOString(),
  });
  stripReq(D5);

  const first = await call(); // starts the rebuild; may or may not include it yet
  assert.equal(first.modelView, "requested");
  assert.equal(typeof first.requestedBackfill.generation, "number");
  await usage.scheduleRequestedBackfill(db);

  // Within the cache TTL: the generation moved, so these are fresh figures.
  const second = await call();
  assert.equal(second.requestedBackfill.running, false);
  assert.equal(second.requestedBackfill.stale, false);
  assert.ok(!second.upstreamOnlyDays.includes(D5), "the rebuilt day is read from its requested maps");
  assert.equal(second.byModel["combo-b"]?.requests, 1);
});
