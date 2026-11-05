// Admin token statistics (change usage-analytics).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-token-stats-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const stats = await import("../src/lib/stats/tokenStats.js");

let db;
before(async () => { db = await getAdapter(); });
after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

let nextId = 1;
function usage({ ts, provider = "openai", model = "gpt-up", requested = "gpt-5", keyId = "k1", input = 100, output = 50, cached = 0, cost = 1000, status = "ok" }) {
  const id = nextId++;
  db.run(
    `INSERT INTO usageHistory(id, timestamp, provider, model, apiKeyId, promptTokens, completionTokens, costNanoUsd, status, tokens, meta)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, ts, provider, model, keyId, input, output, cost, status, JSON.stringify({ cached_tokens: cached }), JSON.stringify(requested ? { requestedModel: requested } : {})]
  );
  return id;
}

beforeEach(() => {
  for (const t of ["usageHistory", "creditLedger", "apiKeys", "deletedApiKeys", "users"]) db.run(`DELETE FROM ${t}`);
  const now = new Date().toISOString();
  db.run(`INSERT INTO users(id, email, passwordHash, status, overdraftNanoUsd, createdAt, updatedAt) VALUES('ua', 'a@x.vn', 'x', 'active', 0, ?, ?)`, [now, now]);
  db.run(`INSERT INTO users(id, email, passwordHash, status, overdraftNanoUsd, createdAt, updatedAt) VALUES('ub', 'b@x.vn', 'x', 'active', 0, ?, ?)`, [now, now]);
  db.run(`INSERT INTO apiKeys(id, key, name, userId, isActive, createdAt) VALUES('k1', 'sk-1', 'one', 'ua', 1, ?)`, [now]);
  db.run(`INSERT INTO deletedApiKeys(keyHash, apiKeyId, userId, deletedAt) VALUES('h2', 'k2', 'ub', ?)`, [now]);
});

const q = (input) => {
  const parsed = stats.parseStatsQuery(input, Date.parse("2026-11-06T00:00:00Z"));
  assert.equal(parsed.ok, true, parsed.error);
  return stats.tokenStatsSync(db, parsed.value);
};

test("buckets are Vietnam local time; weeks start on Monday", () => {
  // 2026-11-05 20:30 UTC = 2026-11-06 03:30 in Vietnam (a Friday).
  const ms = Date.parse("2026-11-05T20:30:00Z");
  assert.equal(stats.bucketKeyOf(ms, "hour"), "2026-11-06 03:00");
  assert.equal(stats.bucketKeyOf(ms, "day"), "2026-11-06");
  assert.equal(stats.bucketKeyOf(ms, "week"), "2026-11-02");
  assert.equal(stats.bucketKeyOf(ms, "month"), "2026-11");
  usage({ ts: "2026-11-05T20:30:00.000Z" });
  const res = q({ from: "2026-11-01T00:00:00Z", to: "2026-11-08T00:00:00Z", granularity: "week" });
  const filled = res.series.filter((s) => s.requests > 0).map((s) => s.bucket);
  assert.deepEqual(filled, ["2026-11-02"], "the SQL bucket matches the JS one");
});

test("totals, per-day series and grouping by requested model", () => {
  usage({ ts: "2026-11-03T03:00:00.000Z", requested: "gpt-5", input: 100, output: 50, cached: 20, cost: 1000 });
  usage({ ts: "2026-11-03T04:00:00.000Z", requested: "claude-x", provider: "anthropic", model: "claude-up", input: 300, output: 100, cost: 3000 });
  usage({ ts: "2026-11-04T03:00:00.000Z", requested: "gpt-5", input: 10, output: 5, status: "error", cost: 0 });
  usage({ ts: "2026-11-04T03:00:00.000Z", provider: "platform", requested: "gpt-5", input: 0, output: 0 });

  const res = q({ from: "2026-11-01T00:00:00Z", to: "2026-11-05T00:00:00Z", granularity: "day", groupBy: "model" });
  assert.equal(res.totals.requests, 3, "platform rows are left out");
  assert.equal(res.totals.errors, 1);
  assert.equal(res.totals.input, 410);
  assert.equal(res.totals.output, 155);
  assert.equal(res.totals.cached, 20);
  assert.equal(res.totals.costNanoUsd, 4000);
  assert.deepEqual(res.groups.map((g) => [g.key, g.total]), [["claude-x", 400], ["gpt-5", 165]]);
  const day3 = res.series.find((s) => s.bucket === "2026-11-03");
  assert.equal(day3.requests, 2);
  assert.deepEqual(day3.byGroup, { "claude-x": 400, "gpt-5": 150 });
  assert.equal(res.series.length, 5, "empty days are filled");
});

test("grouping by provider, upstream model and user (deleted keys keep their owner)", () => {
  usage({ ts: "2026-11-03T03:00:00.000Z", keyId: "k1", provider: "openai", model: "gpt-up" });
  usage({ ts: "2026-11-03T03:00:00.000Z", keyId: "k2", provider: "anthropic", model: "claude-up" });
  usage({ ts: "2026-11-03T03:00:00.000Z", keyId: null, provider: "openai", model: "gpt-up" });
  const range = { from: "2026-11-01T00:00:00Z", to: "2026-11-05T00:00:00Z" };
  assert.deepEqual(q({ ...range, groupBy: "provider" }).groups.map((g) => g.key).sort(), ["anthropic", "openai"]);
  assert.deepEqual(q({ ...range, groupBy: "upstream" }).groups.map((g) => g.key).sort(), ["claude-up", "gpt-up"]);
  const users = q({ ...range, groupBy: "user" }).groups;
  assert.deepEqual(users.map((g) => g.label).sort(), ["Admin / không có chủ", "a@x.vn", "b@x.vn"]);
});

test("filters by user, provider and model; charged credit comes from the ledger", () => {
  const a = usage({ ts: "2026-11-03T03:00:00.000Z", keyId: "k1", requested: "gpt-5" });
  usage({ ts: "2026-11-03T03:00:00.000Z", keyId: "k2", requested: "claude-x", provider: "anthropic" });
  db.run(`INSERT INTO creditLedger(userId, usageId, deltaNanoUsd, kind, createdAt) VALUES('ua', ?, -800, 'charge', '2026-11-03T03:00:01.000Z')`, [a]);
  db.run(`INSERT INTO creditLedger(userId, usageId, deltaNanoUsd, kind, createdAt) VALUES('ua', ?, -100, 'charge', '2026-11-03T03:00:01.000Z')`, [a]);
  const range = { from: "2026-11-01T00:00:00Z", to: "2026-11-05T00:00:00Z" };
  assert.equal(q({ ...range, userId: "ua" }).totals.requests, 1);
  assert.equal(q({ ...range, userId: "ub" }).totals.requests, 1);
  assert.equal(q({ ...range, provider: "anthropic" }).totals.requests, 1);
  assert.equal(q({ ...range, model: "gpt-5" }).totals.requests, 1);
  const byUser = q({ ...range, groupBy: "user" });
  assert.equal(byUser.totals.chargedNanoUsd, 900);
  assert.equal(byUser.groups.find((g) => g.key === "ua").chargedNanoUsd, 900, "two charge rows of one request add up");
  assert.equal(byUser.groups.find((g) => g.key === "ua").requests, 1, "a split charge does not double the request");
});

test("query validation", () => {
  const now = Date.parse("2026-11-06T00:00:00Z");
  assert.equal(stats.parseStatsQuery({ from: "2026-11-05", to: "2026-11-01" }, now).ok, false);
  assert.match(stats.parseStatsQuery({ from: "2026-01-01", to: "2026-11-01", granularity: "hour" }, now).error, /Quá nhiều mốc/);
  const def = stats.parseStatsQuery({}, now).value;
  assert.equal(def.granularity, "day");
  assert.equal(def.groupBy, "model");
  assert.equal(stats.parseStatsQuery({ groupBy: "drop table" }, now).value.groupBy, "model");
});

test("usage keeps its customer after the key and its tombstone are gone", () => {
  // Newer rows carry the owner themselves.
  db.run(
    `INSERT INTO usageHistory(id, timestamp, provider, model, apiKeyId, userId, promptTokens, completionTokens, costNanoUsd, status, meta)
     VALUES(9001, '2026-11-03T03:00:00.000Z', 'openai', 'gpt-up', 'gone-key', 'ua', 100, 50, 1000, 'ok', '{}')`
  );
  // Older rows: no owner column, key and tombstone purged; the charge still says who paid.
  db.run(
    `INSERT INTO usageHistory(id, timestamp, provider, model, apiKeyId, promptTokens, completionTokens, costNanoUsd, status, meta)
     VALUES(9002, '2026-11-03T03:00:00.000Z', 'openai', 'gpt-up', 'gone-key-2', 10, 5, 100, 'ok', '{}')`
  );
  db.run(`INSERT INTO creditLedger(userId, usageId, deltaNanoUsd, kind, createdAt) VALUES('ub', 9002, -100, 'charge', '2026-11-03T03:00:01.000Z')`);
  const res = q({ from: "2026-11-01T00:00:00Z", to: "2026-11-05T00:00:00Z", groupBy: "user" });
  assert.equal(res.groups.find((g) => g.key === "ua").requests, 1);
  assert.equal(res.groups.find((g) => g.key === "ub").requests, 1);
  assert.equal(res.groups.find((g) => g.key === "ub").chargedNanoUsd, 100);
  assert.equal(res.groups.some((g) => g.key === ""), false, "nothing falls to the admin row");
  assert.equal(q({ from: "2026-11-01T00:00:00Z", to: "2026-11-05T00:00:00Z", userId: "ub" }).totals.requests, 1);
});

test("a back-charge counts at its request's time; unlimited-plan charges take no credit", () => {
  const inRange = usage({ ts: "2026-11-03T03:00:00.000Z" });
  const before = usage({ ts: "2026-10-20T03:00:00.000Z" });
  // Back-charged at boot, long after the request.
  db.run(`INSERT INTO creditLedger(userId, usageId, deltaNanoUsd, kind, meta, createdAt) VALUES('ua', ?, -500, 'charge', '{"backfill":true}', '2026-11-10T00:00:00.000Z')`, [inRange]);
  db.run(`INSERT INTO creditLedger(userId, usageId, deltaNanoUsd, kind, meta, createdAt) VALUES('ua', ?, -700, 'charge', '{"backfill":true}', '2026-11-03T05:00:00.000Z')`, [before]);
  db.run(`INSERT INTO creditLedger(userId, usageId, deltaNanoUsd, kind, meta, createdAt) VALUES('ua', ?, -900, 'charge', '{"unlimited":true}', '2026-11-03T03:00:01.000Z')`, [inRange]);
  const res = stats.tokenStatsSync(db, stats.parseStatsQuery({ from: "2026-11-01T00:00:00Z", to: "2026-11-05T00:00:00Z" }, Date.parse("2026-11-12T00:00:00Z")).value);
  assert.equal(res.totals.chargedNanoUsd, 500, "only the back-charge of the in-range request");
  assert.ok(res.series.every((s) => s.bucket >= "2026-11-01" && s.bucket <= "2026-11-05"), "no bucket outside the range");
});
