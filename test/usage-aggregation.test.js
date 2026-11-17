// The usage dashboard summaries against a real throwaway SQLite database.
//
// They scan usageHistory, which on a busy installation holds millions of rows, so they
// aggregate inside SQLite (getUsageStats 24h / lastUsed overlay) or read the range in
// short slices that yield to the event loop (provider and per-customer summaries). These
// tests pin the numbers by hand on a small data set and prove that slicing never changes
// a result, however thin the slices are.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-usage-agg-"));

const { getAdapter } = await import("../src/lib/db/driver.js");
const usage = await import("../src/lib/db/repos/usageRepo.js");

let db;
const MIN = 60_000;
// Aligned to the start of a minute so two rows 10 s apart share one per-minute bucket.
const base = Math.floor(Date.now() / MIN) * MIN - 10 * MIN;
const iso = (ms) => new Date(ms).toISOString();
const range = { startDate: iso(base - 6 * 3600_000), endDate: iso(base + 3600_000) };

function insertRow(r) {
  db.run(
    `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, apiKeyId, endpoint, promptTokens, completionTokens, cost, costNanoUsd, status, tokens, meta)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [r.ts, r.provider, r.model, "conn-1", r.apiKey ?? null, r.apiKeyId ?? null, "/v1/chat/completions",
      r.prompt, r.completion, r.cost ?? 0, r.nano ?? 0, "ok", r.tokens, r.meta]
  );
}

before(async () => {
  db = await getAdapter();
});

test("an empty history yields empty summaries without scanning", async () => {
  assert.deepEqual((await usage.getProviderUsageSummary()).items, []);
  assert.deepEqual(await usage.getUsageByOwner(), []);
});

test("setup", () => {
  db.run(`INSERT INTO users(id, email, passwordHash, displayName, status, createdAt, updatedAt) VALUES('u1','u1@x.test','x','User One','active',?,?)`, [iso(base), iso(base)]);
  db.run(`INSERT INTO apiKeys(id, key, keyPrefix, name, userId, isActive, createdAt, keyHash) VALUES('keyA','sk-legacy-aaaaaaaaaaaaaaaa','sk-A','Key A','u1',1,?, 'hash-a')`, [iso(base)]);

  // r1 + r2 share one minute. r2 is requested under a combo name and its cache read
  // comes from cache_read_input_tokens (cached_tokens is 0).
  insertRow({ ts: iso(base + 5_000), provider: "P1", model: "M1", apiKeyId: "keyA", prompt: 100, completion: 50, nano: 3_000_000,
    tokens: JSON.stringify({ prompt_tokens: 100, completion_tokens: 50, cached_tokens: 20 }), meta: JSON.stringify({ latencyMs: 1000 }) });
  insertRow({ ts: iso(base + 15_000), provider: "P1", model: "M1", apiKeyId: "keyA", prompt: 200, completion: 100, nano: 6_000_000,
    tokens: JSON.stringify({ prompt_tokens: 200, completion_tokens: 100, cached_tokens: 0, cache_read_input_tokens: 7 }),
    meta: JSON.stringify({ latencyMs: 500, requestedModel: "combo-x" }) });
  // r3: malformed tokens JSON, legacy float cost only, no meta.
  insertRow({ ts: iso(base - 290 * MIN), provider: "P2", model: "M2", apiKeyId: "keyA", prompt: 10, completion: 5, cost: 0.000002, nano: 0,
    tokens: "{bad json", meta: null });
  // r4: keyless traffic, older than r1/r2.
  insertRow({ ts: iso(base - 10 * MIN), provider: "P1", model: "M1", prompt: 5, completion: 1, nano: 1_000,
    tokens: JSON.stringify({ prompt_tokens: 5, completion_tokens: 1 }), meta: JSON.stringify({}) });
});

test("getUsageStats(24h) aggregates tokens, cost and lastUsed per bucket", async () => {
  const stats = await usage.getUsageStats("24h");
  assert.equal(stats.totalRequests, 4);
  assert.equal(stats.totalCostNanoUsd, 9_003_000);

  const p1 = stats.byProvider.P1;
  assert.equal(p1.requests, 3);
  assert.equal(p1.promptTokens, 305);
  assert.equal(p1.completionTokens, 151);
  // cached_tokens, falling back to cache_read_input_tokens when it is 0
  assert.equal(p1.cachedTokens, 27);
  assert.equal(p1.costNanoUsd, 9_001_000);

  // a malformed tokens blob counts as empty; a legacy float cost is rounded once
  const p2 = stats.byProvider.P2;
  assert.equal(p2.requests, 1);
  assert.equal(p2.promptTokens, 0);
  assert.equal(p2.costNanoUsd, 2000);

  const m1 = stats.byModel["M1 (P1)"];
  assert.equal(m1.requests, 3);
  assert.equal(m1.lastUsed, iso(base + 15_000));

  assert.equal(stats.byApiKey["local-no-key"].requests, 1);
  assert.equal(stats.byApiKey["id:keyA|M1|P1"].requests, 2);
  assert.equal(stats.byApiKey["id:keyA|M1|P1"].lastUsed, iso(base + 15_000));
});

test("getProviderUsageSummary: totals, per-minute peaks and fastest request", async () => {
  const { items, totals } = await usage.getProviderUsageSummary(range);
  assert.deepEqual(items.map((i) => i.provider), ["P1", "P2"]);

  const p1 = items[0];
  assert.equal(p1.requests, 3);
  assert.equal(p1.input, 305);
  assert.equal(p1.output, 151);
  assert.equal(p1.costNanoUsd, 9_001_000);
  assert.equal(p1.peakRpm, 2);
  assert.equal(p1.peakTpm, 450);
  assert.equal(p1.peakTokS, 200); // 100 tokens in 0.5 s

  // typed columns win over the (malformed) tokens JSON
  assert.equal(items[1].input, 10);
  assert.equal(items[1].costNanoUsd, 2000);
  assert.equal(totals.requests, 4);
  assert.equal(totals.costNanoUsd, 9_003_000);
});

test("getUsageByOwner: per-customer totals, models, cache reads and peaks", async () => {
  const owners = await usage.getUsageByOwner(range);
  const u1 = owners.find((o) => o.ownerId === "u1");
  assert.equal(u1.email, "u1@x.test");
  assert.equal(u1.totals.requests, 3);
  assert.equal(u1.totals.input, 310);
  assert.equal(u1.totals.output, 155);
  // This summary reads `cached_tokens ?? cache_read_input_tokens`: r2 reports an explicit
  // 0, which is kept (the overview uses `||` and would fall back to 7).
  assert.equal(u1.totals.cacheRead, 20);
  assert.equal(u1.peakRpm, 2);
  assert.equal(u1.peakTpm, 450);
  assert.equal(u1.lastUsedAt, iso(base + 15_000));
  // the request made under a combo name is listed under that name
  assert.deepEqual(u1.byModel.map((m) => m.model).sort(), ["M1", "M2", "combo-x"]);
  assert.equal(u1.keys.find((k) => k.id === "keyA").requests, 3);

  const admin = owners.find((o) => o.ownerId === "__admin");
  assert.equal(admin.totals.requests, 1);
  assert.equal(admin.keys[0].noKey, true);
});

test("slicing never changes a result, however thin the slices are", async () => {
  const providerWhole = await usage.getProviderUsageSummary(range);
  const ownersWhole = await usage.getUsageByOwner(range);
  for (const sliceMs of [MIN, 7 * MIN, 37 * MIN, 24 * 3600_000]) {
    assert.deepEqual(await usage.getProviderUsageSummary({ ...range, sliceMs }), providerWhole, `provider @${sliceMs}`);
    assert.deepEqual(await usage.getUsageByOwner({ ...range, sliceMs }), ownersWhole, `owners @${sliceMs}`);
  }
  // an open-ended range (no dates) starts at the oldest row and reaches the newest
  const openProvider = await usage.getProviderUsageSummary({ sliceMs: 30 * MIN });
  assert.equal(openProvider.totals.requests, 4);
  const openOwners = await usage.getUsageByOwner({ sliceMs: 30 * MIN });
  assert.equal(openOwners.reduce((n, o) => n + o.totals.requests, 0), 4);
});

test("the end date is inclusive and an invalid date is refused before any read", async () => {
  const exactly = await usage.getProviderUsageSummary({ startDate: iso(base + 5_000), endDate: iso(base + 5_000) });
  assert.equal(exactly.totals.requests, 1);
  await assert.rejects(usage.getUsageByOwner({ startDate: "not-a-date" }), RangeError);
  await assert.rejects(usage.getProviderUsageSummary({ endDate: "nope" }), RangeError);
});

test("a far-away range is clamped to the data instead of walking every slice", async () => {
  // 1970 .. year 9999 at the default 3 h slice would be ~29 billion slices; it must
  // return at once with the same totals as the open range.
  const started = Date.now();
  const wide = await usage.getProviderUsageSummary({ startDate: "1970-01-01T00:00:00.000Z", endDate: "9999-01-01T00:00:00.000Z" });
  assert.ok(Date.now() - started < 2000, "clamped");
  assert.equal(wide.totals.requests, (await usage.getProviderUsageSummary()).totals.requests);
  const owners = await usage.getUsageByOwner({ startDate: "2000-01-01T00:00:00.000Z" });
  assert.equal(owners.reduce((n, o) => n + o.totals.requests, 0), 4);
  // a range entirely outside the data is empty, not an error
  const none = await usage.getProviderUsageSummary({ startDate: "1999-01-01T00:00:00.000Z", endDate: "1999-02-01T00:00:00.000Z" });
  assert.deepEqual(none.items, []);
});

test("a row stamped in the future is counted when no end date is given", async () => {
  insertRow({ ts: iso(Date.now() + 3 * 24 * 3600_000), provider: "P9", model: "M9", prompt: 7, completion: 3, tokens: "{}", meta: null });
  const open = await usage.getProviderUsageSummary({ sliceMs: 60 * MIN });
  assert.ok(open.items.some((i) => i.provider === "P9"));
  // but an explicit end date before it excludes it, as the single query did
  const bounded = await usage.getProviderUsageSummary({ ...range, sliceMs: 60 * MIN });
  assert.ok(!bounded.items.some((i) => i.provider === "P9"));
  db.run(`DELETE FROM usageHistory WHERE provider = 'P9'`);
});

test("platform denials are not provider usage", async () => {
  insertRow({ ts: iso(base + 20_000), provider: "platform", model: "M1", prompt: 1, completion: 1, tokens: "{}", meta: null });
  const { items } = await usage.getProviderUsageSummary(range);
  assert.ok(!items.some((i) => i.provider === "platform"));
});
