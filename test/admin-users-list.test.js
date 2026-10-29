// Admin users list — filters, sorting and pagination (spec admin-user-management
// "Users list", task 18.4).
//
// This suite exists because the list shipped with THREE broken filter predicates:
// the WHERE clause was applied to the outer query over the `d` CTE while still
// qualifying columns as `u.email` / `u.groupId` / `u.status`. Every search and every
// filter threw "no such column" → 500. The rest of the suite passed because nothing
// called listUsersAdmin with a filter at all.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-adminusers-test-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const { listUsersAdmin, getUserSummary, getUserUsage } = await import("../src/lib/db/repos/adminUsersRepo.js");
const { NANO } = await import("../src/shared/utils/money.js");

let db;
const USD = (n) => Math.round(n * NANO);
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 29, 10, 0, 0);
const at = (ms) => new Date(ms).toISOString();

before(async () => { db = await getAdapter(); });

after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  for (const table of [
    "userPlanWindows", "creditLedger", "userPlans", "orders", "plans",
    "usageHistory", "apiKeys", "userSessions", "users", "keyGroups", "userAuditLog",
  ]) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* partial schema */ }
  }
});

function group(id, name) {
  db.run(
    `INSERT INTO keyGroups(id, name, isActive, createdAt, updatedAt) VALUES(?, ?, 1, ?, ?)`,
    [id, name, at(T0), at(T0)]
  );
}

function user(id, { email = `${id}@test.local`, displayName = null, groupId = null, status = "active", debt = 0, createdAt = T0, lastLoginAt = null } = {}) {
  db.run(
    `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt, lastLoginAt)
     VALUES(?, ?, 'x', ?, ?, ?, ?, ?, ?, ?)`,
    [id, email, displayName, groupId, status, debt, at(createdAt), at(createdAt), lastLoginAt ? at(lastLoginAt) : null]
  );
}

function purchase(id, userId, { remainingUsd = 100, status = "active", hours = 720 } = {}) {
  db.run(
    `INSERT INTO userPlans(id, userId, planId, orderId, source, creditTotalNanoUsd, creditRemainingNanoUsd, startsAt, expiresAt, status, createdAt)
     VALUES(?, ?, NULL, NULL, 'purchase', ?, ?, ?, ?, ?, ?)`,
    [id, userId, USD(100), USD(remainingUsd), at(T0), at(T0 + hours * 3_600_000), status, at(T0)]
  );
}

function key(id, userId) {
  db.run(
    `INSERT INTO apiKeys(id, key, name, isActive, createdAt, userId) VALUES(?, ?, ?, 1, ?, ?)`,
    [id, `secret-${id}`, id, at(T0), userId]
  );
}

function usage(id, apiKeyId, { costUsd = 1, when = T0, prompt = 10, completion = 10 } = {}) {
  db.run(
    `INSERT INTO usageHistory(id, timestamp, provider, model, apiKeyId, promptTokens, completionTokens, costNanoUsd, status, meta)
     VALUES(?, ?, 'p', 'm', ?, ?, ?, ?, 'ok', '{}')`,
    [id, at(when), apiKeyId, prompt, completion, USD(costUsd)]
  );
}

// ── C2: every filter must actually run ─────────────────────────────────────

function seedThree() {
  group("g1", "Nhóm Một");
  group("g2", "Nhóm Hai");
  user("u1", { email: "alice@example.com", displayName: "Alice Nguyễn", groupId: "g1" });
  user("u2", { email: "bob@example.com", displayName: "Bob Trần", groupId: "g2", status: "suspended" });
  user("u3", { email: "carol@other.org", displayName: "Carol", groupId: "g1", debt: USD(3) });
}

test("C2: q filters by email and by display name, case-insensitively", async () => {
  seedThree();

  const byEmail = await listUsersAdmin({ q: "alice" });
  assert.deepEqual(byEmail.users.map((u) => u.id), ["u1"]);

  const byName = await listUsersAdmin({ q: "TRẦN" });
  assert.deepEqual(byName.users.map((u) => u.id), ["u2"]);

  const partial = await listUsersAdmin({ q: "example.com" });
  assert.deepEqual(partial.users.map((u) => u.id).sort(), ["u1", "u2"]);
  assert.equal(partial.total, 2);

  const none = await listUsersAdmin({ q: "zzz-nobody" });
  assert.deepEqual(none.users, []);
  assert.equal(none.total, 0);
});

test("C2: groupId filters to one group and counts only those users", async () => {
  seedThree();

  const one = await listUsersAdmin({ groupId: "g1" });
  assert.deepEqual(one.users.map((u) => u.id).sort(), ["u1", "u3"]);
  assert.equal(one.total, 2);

  const two = await listUsersAdmin({ groupId: "g2" });
  assert.deepEqual(two.users.map((u) => u.id), ["u2"]);
  assert.equal(two.total, 1);
});

test("C2: status filters", async () => {
  seedThree();

  const suspended = await listUsersAdmin({ status: "suspended" });
  assert.deepEqual(suspended.users.map((u) => u.id), ["u2"]);

  const active = await listUsersAdmin({ status: "active" });
  assert.deepEqual(active.users.map((u) => u.id).sort(), ["u1", "u3"]);
});

test("C2: filters combine", async () => {
  seedThree();
  const combined = await listUsersAdmin({ groupId: "g1", status: "active", q: "carol" });
  assert.deepEqual(combined.users.map((u) => u.id), ["u3"]);
});

test("C2: every filter runs without throwing (regression on the u. alias)", async () => {
  seedThree();
  // One call per predicate, each of which threw "no such column: u.email" before.
  await assert.doesNotReject(() => listUsersAdmin({ q: "a" }));
  await assert.doesNotReject(() => listUsersAdmin({ groupId: "g1" }));
  await assert.doesNotReject(() => listUsersAdmin({ status: "active" }));
  await assert.doesNotReject(() => listUsersAdmin({ planState: "active" }));
  await assert.doesNotReject(() => listUsersAdmin({ sort: "available", dir: "asc" }));
});

// ── planState ──────────────────────────────────────────────────────────────

test("planState active / none / debt partition the list", async () => {
  user("u1");
  user("u2", { debt: USD(5) });
  user("u3");
  purchase("up-has", "u1");
  purchase("up-dead", "u3", { status: "expired" });

  const active = await listUsersAdmin({ planState: "active" });
  assert.deepEqual(active.users.map((u) => u.id), ["u1"]);

  const none = await listUsersAdmin({ planState: "none" });
  assert.deepEqual(none.users.map((u) => u.id).sort(), ["u2", "u3"]);

  const debt = await listUsersAdmin({ planState: "debt" });
  assert.deepEqual(debt.users.map((u) => u.id), ["u2"]);
  assert.equal(debt.users[0].debtNanoUsd, USD(5));
});

// ── Sorting ────────────────────────────────────────────────────────────────

test("sorting by available and spend30d, both directions", async () => {
  user("u-low");
  user("u-high");
  purchase("up-low", "u-low", { remainingUsd: 10 });
  purchase("up-high", "u-high", { remainingUsd: 90 });

  key("k-low", "u-low");
  key("k-high", "u-high");
  usage(1, "k-low", { costUsd: 50, when: Date.now() });
  usage(2, "k-high", { costUsd: 5, when: Date.now() });

  const byAvailableDesc = await listUsersAdmin({ sort: "available", dir: "desc" });
  assert.deepEqual(byAvailableDesc.users.map((u) => u.id), ["u-high", "u-low"]);

  const byAvailableAsc = await listUsersAdmin({ sort: "available", dir: "asc" });
  assert.deepEqual(byAvailableAsc.users.map((u) => u.id), ["u-low", "u-high"]);

  const bySpendDesc = await listUsersAdmin({ sort: "spend30d", dir: "desc" });
  assert.deepEqual(bySpendDesc.users.map((u) => u.id), ["u-low", "u-high"]);
  assert.equal(bySpendDesc.users[0].spend30dNanoUsd, USD(50));
});

test("sorting by createdAt and lastLoginAt", async () => {
  user("u-old", { createdAt: T0 - 10 * DAY, lastLoginAt: T0 });
  user("u-new", { createdAt: T0, lastLoginAt: T0 - 10 * DAY });

  const createdDesc = await listUsersAdmin({ sort: "createdAt", dir: "desc" });
  assert.deepEqual(createdDesc.users.map((u) => u.id), ["u-new", "u-old"]);

  const loginDesc = await listUsersAdmin({ sort: "lastLoginAt", dir: "desc" });
  assert.deepEqual(loginDesc.users.map((u) => u.id), ["u-old", "u-new"]);
});

test("an unknown sort falls back to createdAt instead of injecting SQL", async () => {
  user("u1");
  const result = await listUsersAdmin({ sort: "email; DROP TABLE users", dir: "asc" });
  assert.equal(result.total, 1);
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM users`)?.n, 1, "the table is still there");
});

// ── Pagination ─────────────────────────────────────────────────────────────

test("pagination returns page slices and the unpaged total", async () => {
  for (let i = 0; i < 7; i += 1) user(`u${i}`, { createdAt: T0 + i * 1000 });

  const page1 = await listUsersAdmin({ page: 1, pageSize: 3, sort: "createdAt", dir: "asc" });
  assert.equal(page1.users.length, 3);
  assert.equal(page1.total, 7);
  assert.equal(page1.page, 1);
  assert.equal(page1.pageSize, 3);
  assert.deepEqual(page1.users.map((u) => u.id), ["u0", "u1", "u2"]);

  const page3 = await listUsersAdmin({ page: 3, pageSize: 3, sort: "createdAt", dir: "asc" });
  assert.deepEqual(page3.users.map((u) => u.id), ["u6"]);

  const beyond = await listUsersAdmin({ page: 99, pageSize: 3 });
  assert.deepEqual(beyond.users, []);
  assert.equal(beyond.total, 7);
});

test("pageSize defaults to 50 and is capped at 100", async () => {
  const defaults = await listUsersAdmin({});
  assert.equal(defaults.pageSize, 50);

  const capped = await listUsersAdmin({ pageSize: 5000 });
  assert.equal(capped.pageSize, 100);

  const floor = await listUsersAdmin({ pageSize: 0 });
  assert.equal(floor.pageSize, 50, "0 falls back to the default");
});

// ── Aggregates ─────────────────────────────────────────────────────────────

test("each row carries queued plans, credit, 30-day spend and last API use", async () => {
  user("u1");
  purchase("up-1", "u1", { remainingUsd: 40 });
  purchase("up-2", "u1", { remainingUsd: 10 });
  key("k1", "u1");
  usage(1, "k1", { costUsd: 2, when: Date.now() - DAY });
  usage(2, "k1", { costUsd: 3, when: Date.now() - 2 * DAY });
  // Outside the 30-day window: must not count.
  usage(3, "k1", { costUsd: 99, when: Date.now() - 40 * DAY });

  const { users } = await listUsersAdmin({});
  const row = users.find((u) => u.id === "u1");
  assert.equal(row.queuedPlans, 2);
  assert.equal(row.availableNanoUsd, USD(50));
  assert.equal(row.spend30dNanoUsd, USD(5));
  assert.ok(row.lastUsageAt);
});

test("getUserSummary reports credit, debt, 7/30-day spend, keys and sessions", async () => {
  user("u1", { debt: USD(2) });
  purchase("up-1", "u1", { remainingUsd: 20 });
  key("k1", "u1");
  usage(1, "k1", { costUsd: 4, when: Date.now() - DAY });
  usage(2, "k1", { costUsd: 6, when: Date.now() - 10 * DAY });
  db.run(
    `INSERT INTO userSessions(id, userId, tokenHash, createdAt, expiresAt, revokedAt) VALUES('s1','u1','h',?,?,NULL)`,
    [at(T0), at(Date.now() + DAY)]
  );

  const summary = await getUserSummary("u1");
  assert.equal(summary.availableNanoUsd, USD(18), "$20 credit − $2 debt");
  assert.equal(summary.debtNanoUsd, USD(2));
  assert.equal(summary.spend7dNanoUsd, USD(4));
  assert.equal(summary.spend30dNanoUsd, USD(10));
  assert.equal(summary.keyCount, 1);
  assert.equal(summary.sessionCount, 1);
});

test("getUserUsage groups by day and by model for the chosen range", async () => {
  user("u1");
  key("k1", "u1");
  usage(1, "k1", { costUsd: 1, when: Date.now() - DAY, prompt: 100, completion: 50 });
  usage(2, "k1", { costUsd: 2, when: Date.now() - DAY, prompt: 200, completion: 60 });
  usage(3, "k1", { costUsd: 5, when: Date.now() - 20 * DAY });

  const week = await getUserUsage("u1", { range: "7d" });
  assert.equal(week.range, "7d");
  assert.equal(week.daily.length, 1, "both recent rows share a day");
  assert.equal(week.daily[0].requests, 2);
  assert.equal(week.daily[0].costNanoUsd, USD(3));
  assert.equal(week.byModel.length, 1);
  assert.equal(week.byModel[0].promptTokens, 300);
  assert.equal(week.byModel[0].completionTokens, 110);

  const month = await getUserUsage("u1", { range: "30d" });
  assert.equal(month.daily.length, 2, "the 20-day-old row is in range too");
  assert.equal(month.daily.reduce((sum, d) => sum + d.costNanoUsd, 0), USD(8));
});
