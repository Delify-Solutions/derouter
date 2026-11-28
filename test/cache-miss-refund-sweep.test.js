// Daily cache-miss refund sweep (change cache-miss-auto-refund, capability
// cache-miss-refund "Daily capped auto-refund") — against a real throwaway SQLite
// database, same convention as test/billing.test.js.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-cache-miss-sweep-test-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const billing = await import("../src/lib/db/repos/billingRepo.js");
const { runCacheMissRefundSweepSync } = await import("../src/lib/billing/cacheMissRefund.js");
const { insertCacheMissDetectionSync } = await import("../src/lib/db/repos/cacheMissRepo.js");
const { NANO } = await import("../src/shared/utils/money.js");

let db;
const USD = (n) => Math.round(n * NANO);
let usageIdSeq = 1000;
// Real "now" (not a fixed past/future literal): grantWithExpiry stamps startsAt
// with the real current time, and the fallback-plan resolution path (evaluatePlan)
// checks a plan has actually started — a fixed-past "at" would make every freshly
// granted plan look not-yet-started.
const BASE_MS = Date.now();
const iso = (offsetMs = 0) => new Date(BASE_MS + offsetMs).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

async function reset() {
  for (const t of ["cacheMissDetections", "creditLedger", "userPlans", "orders", "plans", "apiKeys", "users"]) {
    try { db.run(`DELETE FROM ${t}`); } catch { /* table may not exist on a partial schema */ }
  }
}

function insertUser(id, email) {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
     VALUES(?, ?, 'x', 'T', NULL, 'active', 0, ?, ?)`,
    [id, email, now, now]
  );
  return id;
}

function insertPlan(id, code, priceUsd, creditUsd, days) {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO plans(id, code, name, description, priceNanoUsd, creditNanoUsd, durationDays, isActive, sortOrder, createdAt, updatedAt)
     VALUES(?, ?, ?, NULL, ?, ?, ?, 1, 0, ?, ?)`,
    [id, code, code, USD(priceUsd), USD(creditUsd), days, now, now]
  );
  return id;
}

function grantWithExpiry({ userId, planId, creditUsd, expiresInHours }) {
  const id = `up_${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date();
  const startsAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + expiresInHours * 3600_000).toISOString();
  db.run(
    `INSERT INTO userPlans(id, userId, planId, orderId, source, creditTotalNanoUsd, creditRemainingNanoUsd, startsAt, expiresAt, status, createdAt)
     VALUES(?, ?, ?, NULL, 'purchase', ?, ?, ?, ?, 'active', ?)`,
    [id, userId, planId, USD(creditUsd), USD(creditUsd), startsAt, expiresAt, startsAt]
  );
  return id;
}

/** A realistic original charge: a 'charge' ledger row with a real usageId, drawn from `planId`. */
function chargeOriginal({ userId, costUsd }) {
  const usageId = (usageIdSeq += 1);
  const result = db.transaction(() =>
    billing.chargeCreditsSync(db, { userId, apiKeyId: null, usageId, requestKey: `usage:${usageId}`, costNanoUsd: USD(costUsd) })
  );
  return { usageId, result };
}

function flagDetection({ usageHistoryId, userId, refundUsd, detectedAt }) {
  return db.transaction(() =>
    insertCacheMissDetectionSync(db, {
      usageHistoryId,
      userId,
      apiKeyId: null,
      provider: "test-provider",
      model: "test-model",
      overlapTokens: 1000,
      refundNanoUsd: USD(refundUsd),
      detectedAt,
    })
  );
}

function detectionRow(id) {
  return db.get(`SELECT * FROM cacheMissDetections WHERE id = ?`, [id]);
}

function planRow(id) {
  return db.get(`SELECT * FROM userPlans WHERE id = ?`, [id]);
}

before(async () => {
  db = await getAdapter();
  await reset();
});

after(() => {
  try { db?.close?.(); } catch { /* adapters differ */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("under the cap: all of a user's flagged detections are auto-refunded", async () => {
  await reset();
  const u = insertUser("u-under", "under@test.local");
  const plan = insertPlan("p-under", "under", 1, 100, 30);
  const grant = grantWithExpiry({ userId: u, planId: plan, creditUsd: 100, expiresInHours: 24 });

  const a = chargeOriginal({ userId: u, costUsd: 5 });
  const b = chargeOriginal({ userId: u, costUsd: 3 });
  const idA = flagDetection({ usageHistoryId: a.usageId, userId: u, refundUsd: 1, detectedAt: iso() });
  const idB = flagDetection({ usageHistoryId: b.usageId, userId: u, refundUsd: 2, detectedAt: iso(MIN) });

  const stats = db.transaction(() =>
    runCacheMissRefundSweepSync(db, { dailyCapNanoUsd: USD(10), nowIso: iso(HOUR) })
  );

  assert.equal(stats.refunded, 2);
  assert.equal(stats.refundedNanoUsd, USD(3));
  assert.equal(detectionRow(idA).status, "auto_refunded");
  assert.equal(detectionRow(idB).status, "auto_refunded");

  // Credit was actually restored, not just recorded: the plan had 100 - 5 - 3 = 92
  // after the two charges, then + 1 + 2 refunded = 95.
  assert.equal(planRow(grant).creditRemainingNanoUsd, USD(95));
});

test("over the cap: the amount that fits is refunded, the rest stays pending", async () => {
  await reset();
  const u = insertUser("u-over", "over@test.local");
  const plan = insertPlan("p-over", "over", 1, 100, 30);
  grantWithExpiry({ userId: u, planId: plan, creditUsd: 100, expiresInHours: 24 });

  const a = chargeOriginal({ userId: u, costUsd: 20 });
  const b = chargeOriginal({ userId: u, costUsd: 20 });
  // $8 + $6 = $14 flagged, cap is $10: only the first (in detection order) fits.
  const idA = flagDetection({ usageHistoryId: a.usageId, userId: u, refundUsd: 8, detectedAt: iso() });
  const idB = flagDetection({ usageHistoryId: b.usageId, userId: u, refundUsd: 6, detectedAt: iso(MIN) });

  const stats = db.transaction(() =>
    runCacheMissRefundSweepSync(db, { dailyCapNanoUsd: USD(10), nowIso: iso(HOUR) })
  );

  assert.equal(stats.refunded, 1);
  assert.equal(stats.refundedNanoUsd, USD(8));
  assert.equal(detectionRow(idA).status, "auto_refunded");
  assert.equal(detectionRow(idB).status, "pending", "beyond the cap must stay pending, never dropped");
});

test("re-running the sweep twice never double-refunds", async () => {
  await reset();
  const u = insertUser("u-rerun", "rerun@test.local");
  const plan = insertPlan("p-rerun", "rerun", 1, 100, 30);
  const grant = grantWithExpiry({ userId: u, planId: plan, creditUsd: 100, expiresInHours: 72 });

  const a = chargeOriginal({ userId: u, costUsd: 20 });
  const b = chargeOriginal({ userId: u, costUsd: 20 });
  const idA = flagDetection({ usageHistoryId: a.usageId, userId: u, refundUsd: 8, detectedAt: iso() });
  const idB = flagDetection({ usageHistoryId: b.usageId, userId: u, refundUsd: 6, detectedAt: iso(MIN) });

  const at = iso(HOUR);
  const first = db.transaction(() => runCacheMissRefundSweepSync(db, { dailyCapNanoUsd: USD(10), nowIso: at }));
  assert.equal(first.refunded, 1);

  // Same calendar day: the $8 already auto-refunded counts against the cap, so the
  // remaining $2 of budget cannot cover detection B's $6.
  const second = db.transaction(() => runCacheMissRefundSweepSync(db, { dailyCapNanoUsd: USD(10), nowIso: at }));
  assert.equal(second.refunded, 0);
  assert.equal(detectionRow(idA).status, "auto_refunded");
  assert.equal(detectionRow(idB).status, "pending");

  // The next calendar day (24h later: always a different UTC date) gets a fresh cap.
  const third = db.transaction(() =>
    runCacheMissRefundSweepSync(db, { dailyCapNanoUsd: USD(10), nowIso: iso(DAY + HOUR) })
  );
  assert.equal(third.refunded, 1);
  assert.equal(detectionRow(idB).status, "auto_refunded");

  // Total credited back is exactly 8 + 6 once — never twice.
  const ledgerTotal = db.get(
    `SELECT COALESCE(SUM(deltaNanoUsd), 0) AS total FROM creditLedger WHERE userPlanId = ? AND kind = 'refund'`,
    [grant]
  );
  assert.equal(ledgerTotal.total, USD(14));
});

test("original plan gone falls back to the user's current active plan", async () => {
  await reset();
  const u = insertUser("u-fallback", "fallback@test.local");
  const planOld = insertPlan("p-old", "old", 1, 50, 30);
  const oldGrant = grantWithExpiry({ userId: u, planId: planOld, creditUsd: 50, expiresInHours: 24 });
  const { usageId } = chargeOriginal({ userId: u, costUsd: 10 });
  const idA = flagDetection({ usageHistoryId: usageId, userId: u, refundUsd: 2, detectedAt: iso() });

  // The plan that originally paid is now gone (expired and swept, as a real plan
  // would be by the time the sweep runs the next day).
  db.run(`UPDATE userPlans SET status = 'expired' WHERE id = ?`, [oldGrant]);

  const planNew = insertPlan("p-new", "new", 1, 30, 30);
  const newGrant = grantWithExpiry({ userId: u, planId: planNew, creditUsd: 30, expiresInHours: 24 });

  const stats = db.transaction(() =>
    runCacheMissRefundSweepSync(db, { dailyCapNanoUsd: USD(10), nowIso: iso(HOUR) })
  );

  assert.equal(stats.refunded, 1);
  assert.equal(detectionRow(idA).status, "auto_refunded");
  assert.equal(planRow(newGrant).creditRemainingNanoUsd, USD(32), "the fallback plan received the refund");

  const ledgerRow = db.get(`SELECT * FROM creditLedger WHERE userPlanId = ? AND kind = 'refund'`, [newGrant]);
  assert.ok(ledgerRow, "a refund ledger row was posted against the fallback plan");
  const meta = JSON.parse(ledgerRow.meta || "{}");
  assert.equal(meta.fallbackPlan, true, "the fallback is recorded in the ledger row's meta");
});

test("one user's failure (no plan to credit into) does not block another user's refund", async () => {
  await reset();
  // User A: no plan at all — chargeOriginal becomes an overdraft charge (userPlanId
  // NULL), so there is genuinely nowhere clean to credit a refund into.
  const userA = insertUser("u-nocredit", "nocredit@test.local");
  const { usageId: usageIdA } = chargeOriginal({ userId: userA, costUsd: 5 });
  const idA = flagDetection({ usageHistoryId: usageIdA, userId: userA, refundUsd: 1, detectedAt: iso() });

  // User B: a normal, fundable detection.
  const userB = insertUser("u-ok", "ok@test.local");
  const planB = insertPlan("p-ok", "ok", 1, 50, 30);
  const grantB = grantWithExpiry({ userId: userB, planId: planB, creditUsd: 50, expiresInHours: 24 });
  const { usageId: usageIdB } = chargeOriginal({ userId: userB, costUsd: 5 });
  const idB = flagDetection({ usageHistoryId: usageIdB, userId: userB, refundUsd: 1, detectedAt: iso() });

  const stats = db.transaction(() =>
    runCacheMissRefundSweepSync(db, { dailyCapNanoUsd: USD(10), nowIso: iso(HOUR) })
  );

  assert.equal(stats.refunded, 1);
  assert.equal(stats.skipped, 1);
  assert.equal(detectionRow(idA).status, "pending", "left pending, not silently dropped");
  assert.equal(detectionRow(idB).status, "auto_refunded", "the other user's refund still went through");
  assert.equal(planRow(grantB).creditRemainingNanoUsd, USD(46));
});
