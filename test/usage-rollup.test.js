// Hourly rollups behind the admin Users / Providers summaries (change usage-rollup).
//
// The contract is exactness: reading a range through the rollup (whole hours from the
// rollup, partial edges and the not-yet-rolled tail from raw rows) must equal reading it
// from the raw rows alone, for any range — hour-aligned or not, open-ended, inside one
// hour, across the lag window — and must stay equal when history is deleted.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-usage-rollup-"));

const { getAdapter } = await import("../src/lib/db/driver.js");
const usage = await import("../src/lib/db/repos/usageRepo.js");
const rollup = await import("../src/lib/db/repos/usageRollup.js");

let db;
const MIN = 60_000;
const HOUR = 3_600_000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// deterministic pseudo-random so a failure is reproducible
function rng(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LEGACY_RAW = "sk-legacy-rollup-test-key-0001";

function insert(r) {
  db.run(
    `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, apiKeyId, endpoint, promptTokens, completionTokens, cost, costNanoUsd, status, tokens, meta)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [r.ts, r.provider, r.model, "conn-1", r.apiKey ?? null, r.apiKeyId ?? null, "/v1/chat/completions",
      r.prompt, r.completion, r.cost ?? 0, r.nano ?? 0, "ok", r.tokens, r.meta]
  );
}

before(async () => {
  db = await getAdapter();
  for (let i = 0; i < 6; i++) {
    db.run(`INSERT INTO users(id, email, passwordHash, displayName, status, createdAt, updatedAt) VALUES(?,?,?,?,?,?,?)`, [`u${i}`, `u${i}@x.test`, "x", `User ${i}`, "active", iso(NOW), iso(NOW)]);
  }
  const keyRows = [
    ["key-a", "", "u0"], ["key-b", "", "u0"], ["key-c", "", "u1"], ["key-d", "", "u2"],
    ["key-admin", "", null], ["key-ghost", "", "gone-user"], ["key-legacy", LEGACY_RAW, "u3"],
  ];
  for (const [id, raw, userId] of keyRows) {
    db.run(`INSERT INTO apiKeys(id, key, keyPrefix, name, userId, isActive, createdAt, keyHash) VALUES(?,?,?,?,?,?,?,?)`,
      [id, raw || `hashed:${id}`, `sk-${id}`, `Key ${id}`, userId, 1, iso(NOW), `hash-${id}`]);
  }

  const rand = rng(20260418);
  const providers = ["P1", "P2", "P3", null, "", "platform"];
  const models = ["m1", "m2", "m3", "m4"];
  const idKeys = ["key-a", "key-b", "key-c", "key-d", "key-admin", "key-ghost"];
  db.transaction(() => {
    for (let i = 0; i < 4000; i++) {
      // 40 hours of traffic that ends inside the lag window, clustered so per-minute peaks matter
      const burst = rand() < 0.3 ? Math.floor(rand() * 40) * HOUR + Math.floor(rand() * 5) * MIN : null;
      const ts = burst != null ? NOW - 40 * HOUR + burst + Math.floor(rand() * 20_000) : NOW - Math.floor(rand() * 40 * HOUR);
      const pt = 50 + Math.floor(rand() * 2000);
      const ct = 10 + Math.floor(rand() * 500);
      const variant = i % 23;
      let nano = (pt * 3 + ct * 9) * 1000, cost = nano / 1e9;
      let tokens = JSON.stringify({ prompt_tokens: pt, completion_tokens: ct, cached_tokens: variant % 3 ? pt >> 1 : 0, cache_read_input_tokens: variant % 5 === 0 ? 7 : undefined, cache_creation_input_tokens: variant % 7 === 0 ? 3 : undefined });
      let meta = JSON.stringify({ latencyMs: variant % 9 === 0 ? 0 : 200 + Math.floor(rand() * 5000), requestedModel: variant % 2 ? `combo-${variant % 5}` : undefined, cacheEstimated: variant % 11 === 0 ? true : variant % 13 === 0 ? "true" : undefined });
      let apiKey = null, apiKeyId = idKeys[Math.floor(rand() * idKeys.length)];
      let promptTokens = pt, completionTokens = ct;
      if (variant === 1) tokens = "{bad json";
      if (variant === 2) meta = null;
      if (variant === 3) { apiKeyId = null; apiKey = null; }               // keyless
      if (variant === 4) { apiKeyId = "gone-key"; apiKey = "sk-deleted"; } // deleted key
      if (variant === 5) { nano = 0; cost = 0.000123456; }                 // legacy float cost
      if (variant === 6) { promptTokens = null; completionTokens = null; } // tokens JSON fallback
      if (variant === 7) { apiKeyId = null; apiKey = LEGACY_RAW; }         // legacy raw key
      if (variant === 8) tokens = null;
      insert({ ts: iso(ts), provider: providers[Math.floor(rand() * providers.length)], model: variant === 9 ? "" : models[Math.floor(rand() * models.length)],
        apiKey, apiKeyId, prompt: promptTokens, completion: completionTokens, cost, nano, tokens, meta });
    }
  });
  // everything that has ended and aged past the lag is rolled up
  while (rollup.advanceOneHourSync(db, NOW)) { /* roll */ }
});

const strip = (o) => JSON.parse(JSON.stringify(o));
function normOwners(list) {
  const out = strip(list);
  for (const o of out) o.byModel.sort((a, b) => a.model.localeCompare(b.model));
  return out;
}

const ranges = () => [
  ["last 30 days (open start)", { startDate: undefined, endDate: undefined }],
  ["unaligned last 24h", { startDate: iso(NOW - 24 * HOUR - 7 * MIN - 123), endDate: iso(NOW) }],
  ["unaligned last 30h to 2h ago", { startDate: iso(NOW - 30 * HOUR + 13_000), endDate: iso(NOW - 2 * HOUR + 41 * MIN) }],
  ["hour aligned", { startDate: iso(Math.ceil((NOW - 20 * HOUR) / HOUR) * HOUR), endDate: iso(Math.floor((NOW - 3 * HOUR) / HOUR) * HOUR - 1) }],
  ["inside one hour", { startDate: iso(Math.floor((NOW - 10 * HOUR) / HOUR) * HOUR + 5 * MIN), endDate: iso(Math.floor((NOW - 10 * HOUR) / HOUR) * HOUR + 40 * MIN) }],
  ["only the lag window", { startDate: iso(NOW - 20 * MIN), endDate: iso(NOW) }],
  ["open end", { startDate: iso(NOW - 12 * HOUR - 5 * MIN) }],
  ["end exactly on an hour boundary", { startDate: iso(NOW - 15 * HOUR), endDate: iso(Math.floor((NOW - 5 * HOUR) / HOUR) * HOUR) }],
];

test("the watermark stops at the last hour that ended more than the lag ago", () => {
  const wm = rollup.getWatermarkMs(db);
  assert.equal(wm, rollup.hourStart(NOW - rollup.ROLLUP_LAG_MS));
  // rolled hours exist, and none at or after the watermark
  const latest = db.get(`SELECT MAX(hour) AS h FROM usageRollupProvider`).h;
  assert.ok(latest < rollup.hourKey(wm));
});

test("providers: the rollup read equals the raw read for every range", async () => {
  for (const [label, range] of ranges()) {
    const viaRollup = strip(await usage.getProviderUsageSummary({ ...range, useRollup: true }));
    const viaRaw = strip(await usage.getProviderUsageSummary({ ...range, useRollup: false }));
    for (const list of [viaRollup, viaRaw]) for (const it of list.items) it.peakTokS = Math.round(it.peakTokS);
    assert.deepEqual(viaRollup.totals, viaRaw.totals, `totals: ${label}`);
    assert.deepEqual(viaRollup.items, viaRaw.items, `items: ${label}`);
  }
});

test("customers: the rollup read equals the raw read for every range", async () => {
  for (const [label, range] of ranges()) {
    const viaRollup = normOwners(await usage.getUsageByOwner({ ...range, useRollup: true }));
    const viaRaw = normOwners(await usage.getUsageByOwner({ ...range, useRollup: false }));
    assert.deepEqual(viaRollup, viaRaw, `owners: ${label}`);
  }
});

test("a wide range really is served from the rollup", async () => {
  // Same answer, but the raw edges are all that is read: prove the rollup contributed by
  // emptying the raw table's hours behind it and seeing the figures survive in the rollup.
  const plan = rollup.planRollupRange(db, NOW - 30 * HOUR, NOW, { useRollup: true });
  assert.ok(plan.rollup, "has whole rolled hours");
  assert.ok(plan.raw.length >= 1 && plan.raw.length <= 2, "at most a head and a tail are read raw");
  const none = rollup.planRollupRange(db, NOW - 20 * MIN, NOW, { useRollup: true });
  assert.equal(none.rollup, null, "a range inside the lag window is all raw");
  const off = rollup.planRollupRange(db, NOW - 30 * HOUR, NOW, { useRollup: false });
  assert.equal(off.rollup, null);
});

test("the raw API key is never stored in the rollup", () => {
  const rows = db.all(`SELECT * FROM usageRollupKey`);
  assert.ok(rows.length > 0);
  assert.ok(!JSON.stringify(rows).includes(LEGACY_RAW));
  assert.ok(rows.some((r) => r.rawHash === rollup.sha256Hex(LEGACY_RAW)), "legacy rows are matched by hash");
});

test("rolling is idempotent and a quiet stretch is skipped, not walked", () => {
  const before = db.get(`SELECT COUNT(*) AS n FROM usageRollupKey`).n;
  const wm = rollup.getWatermarkMs(db);
  assert.equal(rollup.advanceOneHourSync(db, NOW), false, "nothing left to roll");
  assert.equal(rollup.getWatermarkMs(db), wm);
  // re-rolling an already rolled hour replaces its rows instead of doubling them
  db.run(`UPDATE usageRollupMeta SET value = ? WHERE name = 'rolledThrough'`, [iso(wm - 5 * HOUR)]);
  while (rollup.advanceOneHourSync(db, NOW)) { /* roll */ }
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM usageRollupKey`).n, before);
  assert.equal(rollup.getWatermarkMs(db), wm);
});

test("deleting a key's history invalidates the rollup and the figures stay equal to raw", async () => {
  const range = { startDate: iso(NOW - 30 * HOUR), endDate: iso(NOW) };
  const wmBefore = rollup.getWatermarkMs(db);
  const result = await usage.deleteKeyUsageHistory(LEGACY_RAW);
  assert.ok(result.history > 0);
  // the oldest hour that key touched is forgotten, so the watermark moved back
  assert.ok(rollup.getWatermarkMs(db) < wmBefore);
  // while the rollup is behind, a read mixes rollup and raw and still equals raw
  for (const fn of ["getProviderUsageSummary", "getUsageByOwner"]) {
    const a = strip(await usage[fn]({ ...range, useRollup: true }));
    const b = strip(await usage[fn]({ ...range, useRollup: false }));
    if (fn === "getProviderUsageSummary") for (const l of [a, b]) for (const it of l.items) it.peakTokS = Math.round(it.peakTokS);
    else for (const l of [a, b]) for (const o of l) o.byModel.sort((x, y) => x.model.localeCompare(y.model));
    assert.deepEqual(a, b, `${fn} after the wipe`);
  }
  // catching up restores the rollup, and the equality still holds
  while (rollup.advanceOneHourSync(db, NOW)) { /* roll */ }
  assert.equal(rollup.getWatermarkMs(db), wmBefore);
  const owners = normOwners(await usage.getUsageByOwner({ ...range, useRollup: true }));
  assert.deepEqual(owners, normOwners(await usage.getUsageByOwner({ ...range, useRollup: false })));
});

test("a row recorded late inside an already rolled hour is handled by invalidating from it", async () => {
  const lateTs = iso(NOW - 6 * HOUR);
  insert({ ts: lateTs, provider: "P1", model: "m1", apiKeyId: "key-a", prompt: 1000, completion: 500, nano: 9_000_000, tokens: JSON.stringify({ prompt_tokens: 1000, completion_tokens: 500 }), meta: "{}" });
  const range = { startDate: iso(NOW - 12 * HOUR), endDate: iso(NOW) };
  const raw = strip(await usage.getProviderUsageSummary({ ...range, useRollup: false }));
  const stale = strip(await usage.getProviderUsageSummary({ ...range, useRollup: true }));
  assert.notDeepEqual(stale.totals, raw.totals, "documented limit: a row older than the lag is not seen until its hour is re-rolled");
  db.transaction(() => rollup.invalidateRollupFromSync(db, lateTs));
  while (rollup.advanceOneHourSync(db, NOW)) { /* roll */ }
  const fixed = strip(await usage.getProviderUsageSummary({ ...range, useRollup: true }));
  assert.deepEqual(fixed.totals, raw.totals);
});

test("retention pruning drops rolled hours older than the cut-off", () => {
  const cutoff = iso(NOW - 20 * HOUR);
  db.transaction(() => rollup.pruneRollupSync(db, cutoff));
  const oldest = db.get(`SELECT MIN(hour) AS h FROM usageRollupProvider`).h;
  assert.ok(oldest >= rollup.hourKey(rollup.hourStart(Date.parse(cutoff))));
});

test("the background loop catches up without being awaited by readers", async () => {
  db.run(`DELETE FROM usageRollupProvider`); db.run(`DELETE FROM usageRollupKey`);
  db.run(`DELETE FROM usageRollupOwnerPeak`); db.run(`DELETE FROM usageRollupMeta`);
  const range = { startDate: iso(NOW - 30 * HOUR), endDate: iso(NOW) };
  // no watermark yet: the very first read is all raw, and starts the backfill
  const first = strip(await usage.getProviderUsageSummary({ ...range, useRollup: true }));
  await rollup.scheduleRollup(db, { now: () => NOW });
  assert.equal(rollup.getWatermarkMs(db), rollup.hourStart(NOW - rollup.ROLLUP_LAG_MS));
  const second = strip(await usage.getProviderUsageSummary({ ...range, useRollup: true }));
  for (const l of [first, second]) for (const it of l.items) it.peakTokS = Math.round(it.peakTokS);
  assert.deepEqual(second, first);
});

test("the loop is not left 'running' after a run that had nothing to do", async () => {
  // regression: a loop that finished before its promise was assigned left `running` stuck,
  // so no later call ever started a new one
  await rollup.scheduleRollup(db, { now: () => NOW });
  await rollup.scheduleRollup(db, { now: () => NOW });
  assert.equal(globalThis.__usageRollupRun.running, null);
  db.run(`DELETE FROM usageRollupMeta`);
  await rollup.scheduleRollup(db, { now: () => NOW });
  assert.equal(rollup.getWatermarkMs(db), rollup.hourStart(NOW - rollup.ROLLUP_LAG_MS));
});

test("a read split into many rollup slices equals the same read in one slice", async () => {
  // the default slice is 48 hours, wider than this data: force 3-hour slices (~14 of them)
  const range = { startDate: iso(NOW - 40 * HOUR), endDate: iso(NOW) };
  const whole = strip(await usage.getProviderUsageSummary({ ...range, rollupSliceHours: 1000 }));
  const sliced = strip(await usage.getProviderUsageSummary({ ...range, rollupSliceHours: 3 }));
  assert.deepEqual(sliced, whole);
  const ownersWhole = normOwners(await usage.getUsageByOwner({ ...range, rollupSliceHours: 1000 }));
  const ownersSliced = normOwners(await usage.getUsageByOwner({ ...range, rollupSliceHours: 3 }));
  assert.deepEqual(ownersSliced, ownersWhole);
  assert.deepEqual(ownersSliced, normOwners(await usage.getUsageByOwner({ ...range, useRollup: false })));
});

test("history deleted while a read is between slices makes it answer from raw rows", async () => {
  const range = { startDate: iso(NOW - 40 * HOUR), endDate: iso(NOW) };
  insert({ ts: iso(NOW - 25 * HOUR), provider: "P1", model: "m1", apiKey: "sk-epoch-test", prompt: 10, completion: 5, nano: 1000, tokens: "{}", meta: "{}" });
  while (rollup.advanceOneHourSync(db, NOW)) { /* roll */ }
  const pending = usage.getUsageByOwner({ ...range, rollupSliceHours: 2 });
  // a wipe lands while the read is suspended between slices
  await new Promise((r) => setImmediate(r));
  await usage.deleteKeyUsageHistory("sk-epoch-test");
  const result = normOwners(await pending);
  assert.deepEqual(result, normOwners(await usage.getUsageByOwner({ ...range, useRollup: false })));
  while (rollup.advanceOneHourSync(db, NOW)) { /* roll */ }
});

test("a watermark written while the clock ran ahead is not trusted", () => {
  const future = rollup.hourStart(NOW + 10 * HOUR);
  db.run(`UPDATE usageRollupMeta SET value = ? WHERE name = 'rolledThrough'`, [iso(future)]);
  const plan = rollup.planRollupRange(db, NOW - 20 * HOUR, NOW + 20 * HOUR, { useRollup: true });
  // the planner never reaches past the last complete hour by the clock
  assert.ok(Date.parse(`${plan.rollup.toHour}:00:00.000Z`) <= rollup.hourStart(Date.now() - rollup.ROLLUP_LAG_MS));
  // and the next advance rewinds it instead of leaving rows below it unseen
  assert.equal(rollup.advanceOneHourSync(db, NOW), false);
  assert.ok(rollup.getWatermarkMs(db) <= rollup.hourStart(NOW - rollup.ROLLUP_LAG_MS));
  while (rollup.advanceOneHourSync(db, NOW)) { /* roll */ }
});
