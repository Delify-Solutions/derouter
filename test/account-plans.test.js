// Customer plan queue and ledger reads (design D18, tasks 15.2/15.3/15.4).
//
// These pin the two rules a customer can be harmed by getting wrong:
//   * a reorder request that is stale or names somebody else's plan changes
//     NOTHING and answers 409 — otherwise a page left open would silently move
//     spending between pools;
//   * every read is scoped to the caller, so pagination and filters can never
//     surface another account's rows.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-accountplans-test-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const { reorderSync } = await import("../src/lib/billing/planQueue.js");
const account = await import("../src/lib/db/repos/accountPlansRepo.js");
const { NANO } = await import("../src/shared/utils/money.js");

let db;
const USD = (n) => Math.round(n * NANO);
const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 29, 10, 0, 0);
const at = (ms) => new Date(ms).toISOString();
const plus = (ms, hours) => at(ms + hours * HOUR);

before(async () => { db = await getAdapter(); });

after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  for (const table of [
    "userPlanWindows",
    "creditLedger",
    "userPlans",
    "orders",
    "plans",
    "apiKeys",
    "users",
    "usageHistory",
    "userAuditLog",
  ]) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* partial schema */ }
  }
});

function user(id) {
  db.run(
    `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
     VALUES(?, ?, 'x', NULL, NULL, 'active', 0, ?, ?)`,
    [id, `${id}@test.local`, at(T0), at(T0)]
  );
}

function plan(id, { code = id, creditUsd = 250, durationDays = 30 } = {}) {
  db.run(
    `INSERT INTO plans(id, code, name, priceNanoUsd, creditNanoUsd, durationDays, isActive, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [id, code, code.toUpperCase(), USD(10), USD(creditUsd), durationDays, at(T0), at(T0)]
  );
}

function grant(id, userId, planId, { creditUsd = 10, hours = 240, status = "active" } = {}) {
  db.run(
    `INSERT INTO userPlans(id, userId, planId, orderId, source, creditTotalNanoUsd, creditRemainingNanoUsd, startsAt, expiresAt, status, priority, limits, createdAt)
     VALUES(?, ?, ?, NULL, 'purchase', ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    [id, userId, planId, USD(creditUsd), USD(creditUsd), at(T0), plus(T0, hours), status, at(T0)]
  );
}

function ledgerRow(userId, { planId = null, kind = "charge", delta = -1, createdAt = at(T0), usageId = null, requestKey = null, meta = null }) {
  db.run(
    `INSERT INTO creditLedger(userId, userPlanId, apiKeyId, usageId, requestKey, deltaNanoUsd, balanceAfterNanoUsd, kind, meta, createdAt)
     VALUES(?, ?, NULL, ?, ?, ?, 0, ?, ?, ?)`,
    [userId, planId, usageId, requestKey, USD(delta), kind, meta ? JSON.stringify(meta) : null, createdAt]
  );
}

// ── Reorder ────────────────────────────────────────────────────────────────

test("reorder refuses another user's plan id with 409 and writes nothing", () => {
  user("u1");
  user("u2");
  plan("p1");
  grant("up-1", "u1", "p1");
  grant("up-2", "u1", "p1");
  grant("up-x", "u2", "p1");

  // u1 submits u2's purchase id in place of one of their own.
  const result = reorderSync(db, "u1", ["up-1", "up-x"], { actor: "customer", nowIso: at(T0) });
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, "queue_changed");

  // No priority was written anywhere.
  const priorities = db.all(`SELECT id, priority FROM userPlans WHERE priority IS NOT NULL`);
  assert.equal(priorities.length, 0);
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM userAuditLog`)?.n, 0);
});

test("reorder rejects an exhausted or expired id as queue_changed", () => {
  user("u1");
  plan("p1");
  grant("up-live", "u1", "p1");
  grant("up-dead", "u1", "p1", { status: "exhausted" });

  const result = reorderSync(db, "u1", ["up-live", "up-dead"], { actor: "customer", nowIso: at(T0) });
  assert.equal(result.code, "queue_changed");
});

test("a successful reorder returns the queue in the saved order", () => {
  user("u1");
  plan("p1");
  grant("up-a", "u1", "p1", { hours: 100 });
  grant("up-b", "u1", "p1", { hours: 200 });

  assert.deepEqual(account.getQueueSync(db, "u1", at(T0)).map((e) => e.id), ["up-a", "up-b"]);

  const result = db.transaction(() => reorderSync(db, "u1", ["up-b", "up-a"], { actor: "customer", nowIso: at(T0) }));
  assert.equal(result.ok, true);

  const queue = account.getQueueSync(db, "u1", at(T0));
  assert.deepEqual(queue.map((e) => e.id), ["up-b", "up-a"]);
  assert.equal(queue[0].statusLabel, "paying", "the first entry is the one admission picks");
  assert.equal(queue[1].statusLabel, "waiting");
});

test("the queue view exposes per-limit window state with labels", () => {
  user("u1");
  plan("p1");
  db.run(
    `INSERT INTO userPlans(id, userId, planId, orderId, source, creditTotalNanoUsd, creditRemainingNanoUsd, startsAt, expiresAt, status, priority, limits, createdAt)
     VALUES('up-w', 'u1', 'p1', NULL, 'purchase', ?, ?, ?, ?, 'active', NULL, ?, ?)`,
    [USD(100), USD(100), at(T0), plus(T0, 240), JSON.stringify([{ hours: 5, maxNanoUsd: USD(20) }]), at(T0)]
  );
  db.run(
    `INSERT INTO userPlanWindows(userPlanId, hours, startedAt, spentNanoUsd) VALUES('up-w', 5, ?, ?)`,
    [at(T0), USD(12)]
  );

  const [entry] = account.getQueueSync(db, "u1", at(T0 + HOUR));
  assert.equal(entry.windows.length, 1);
  assert.equal(entry.windows[0].label, "5 giờ");
  assert.equal(entry.windows[0].maxNanoUsd, USD(20));
  assert.equal(entry.windows[0].spentNanoUsd, USD(12));
  assert.equal(entry.windows[0].open, true);
  assert.equal(entry.windows[0].resetAt, plus(T0, 5));
  assert.equal(entry.windows[0].full, false);
});

// ── History ────────────────────────────────────────────────────────────────

test("history holds only non-active purchases, newest first, capped at 50", () => {
  user("u1");
  plan("p1");
  for (let i = 0; i < 60; i += 1) {
    grant(`up-${i}`, "u1", "p1", { status: i % 2 === 0 ? "expired" : "exhausted" });
  }
  grant("up-live", "u1", "p1");

  const history = account.getPlanHistorySync(db, "u1");
  assert.equal(history.length, 50, "capped");
  assert.equal(history.some((row) => row.id === "up-live"), false, "active purchases are the queue, not history");
  assert.ok(history.every((row) => row.status === "expired" || row.status === "exhausted"));
});

// ── Ledger ─────────────────────────────────────────────────────────────────

test("ledger pages by 25 and never returns another account's rows", () => {
  user("u1");
  user("u2");
  plan("p1");
  grant("up-1", "u1", "p1");
  grant("up-2", "u2", "p1");

  for (let i = 0; i < 30; i += 1) {
    ledgerRow("u1", { planId: "up-1", delta: -1, createdAt: at(T0 + i * 1000) });
  }
  for (let i = 0; i < 5; i += 1) {
    ledgerRow("u2", { planId: "up-2", delta: -1, createdAt: at(T0 + i * 1000) });
  }

  const page1 = account.getAccountLedgerSync(db, "u1", { page: 1 });
  assert.equal(page1.total, 30, "u2's rows are not counted");
  assert.equal(page1.entries.length, 25);
  assert.equal(page1.pageSize, 25);
  assert.equal(page1.page, 1);

  const page2 = account.getAccountLedgerSync(db, "u1", { page: 2 });
  assert.equal(page2.entries.length, 5);

  // Newest first: page 1 starts with the latest createdAt.
  assert.equal(page1.entries[0].createdAt, at(T0 + 29 * 1000));
});

test("ledger filters by plan and kind", () => {
  user("u1");
  plan("p-go", { code: "go" });
  plan("p-pro", { code: "pro" });
  grant("up-go", "u1", "p-go");
  grant("up-pro", "u1", "p-pro");

  ledgerRow("u1", { planId: "up-go", kind: "charge" });
  ledgerRow("u1", { planId: "up-go", kind: "grant", delta: 250 });
  ledgerRow("u1", { planId: "up-pro", kind: "charge" });

  const byPlan = account.getAccountLedgerSync(db, "u1", { planId: "p-go" });
  assert.equal(byPlan.total, 2);

  const byKind = account.getAccountLedgerSync(db, "u1", { kind: "charge" });
  assert.equal(byKind.total, 2);

  const both = account.getAccountLedgerSync(db, "u1", { planId: "p-go", kind: "charge" });
  assert.equal(both.total, 1);
});

test("ledger joins the model and token counts through usageId", () => {
  user("u1");
  plan("p1");
  grant("up-1", "u1", "p1");
  db.run(
    `INSERT INTO usageHistory(id, timestamp, provider, model, apiKeyId, promptTokens, completionTokens, costNanoUsd, status, meta)
     VALUES(7, ?, 'p', 'model-x', NULL, 1200, 300, ?, 'ok', '{}')`,
    [at(T0), USD(0.004)]
  );
  ledgerRow("u1", { planId: "up-1", delta: -0.004, usageId: 7, requestKey: "usage:7" });

  const { entries } = account.getAccountLedgerSync(db, "u1");
  assert.equal(entries[0].model, "model-x");
  assert.equal(entries[0].promptTokens, 1200);
  assert.equal(entries[0].completionTokens, 300);
  assert.equal(entries[0].deltaNanoUsd, -USD(0.004));

  // A row without a usageId (a grant, or a legacy charge) renders without them.
  ledgerRow("u1", { planId: "up-1", kind: "grant", delta: 250 });
  const grantRow = account.getAccountLedgerSync(db, "u1", { kind: "grant" }).entries[0];
  assert.equal(grantRow.model, null);
  assert.equal(grantRow.promptTokens, null);
});

test("a back-charged row is flagged for the page", () => {
  user("u1");
  plan("p1");
  grant("up-1", "u1", "p1");
  ledgerRow("u1", {
    planId: "up-1",
    delta: -2,
    meta: { backfill: true, usageTimestamp: at(T0 - 86400000) },
    requestKey: "usage:99",
  });

  const [entry] = account.getAccountLedgerSync(db, "u1").entries;
  assert.equal(entry.backfill, true);
  assert.equal(entry.kind, "charge");
});

test("plan options list only plans the caller was actually charged against", () => {
  user("u1");
  user("u2");
  plan("p-go", { code: "go" });
  plan("p-pro", { code: "pro" });
  grant("up-go", "u1", "p-go");
  grant("up-pro", "u2", "p-pro");

  ledgerRow("u1", { planId: "up-go" });
  ledgerRow("u2", { planId: "up-pro" });

  const options = account.getLedgerPlanOptionsSync(db, "u1");
  assert.deepEqual(options.map((o) => o.planCode), ["go"]);
});
