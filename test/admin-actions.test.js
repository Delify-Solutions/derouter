// Audited admin actions (spec admin-user-management "Audited admin actions",
// design D13, task 18.3).
//
// For every action: one valid case and one invalid case, with the ledger and audit
// rows asserted. The invariants that matter:
//   * an invalid input writes NOTHING (no purchase, no ledger row, no audit row);
//   * money movements produce exactly one ledger row AND exactly one audit row;
//   * revoke records the forfeited amount as a negative `revoke` row;
//   * adjust below zero is refused.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-adminactions-test-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const actions = await import("../src/lib/billing/adminActions.js");
const { NANO } = await import("../src/shared/utils/money.js");

let db;
const USD = (n) => Math.round(n * NANO);
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 29, 10, 0, 0);
const at = (ms) => new Date(ms).toISOString();
const ACTOR = "admin:ops@test.local";
const REASON = "Hỗ trợ khách hàng";

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
    "giftRedemptions",
    "giftCodes",
    "userAuditLog",
    "apiKeys",
    "userSessions",
    "users",
    "keyGroups",
  ]) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* partial schema */ }
  }
});

// ── Fixtures ───────────────────────────────────────────────────────────────

function user(id = "u1", { debt = 0, status = "active" } = {}) {
  db.run(
    `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, adminNote, createdAt, updatedAt)
     VALUES(?, ?, 'hash', 'Khách', NULL, ?, ?, NULL, ?, ?)`,
    [id, `${id}@test.local`, status, debt, at(T0), at(T0)]
  );
}

function group(id, { name = "Nhóm A", isActive = 1 } = {}) {
  db.run(
    `INSERT INTO keyGroups(id, name, isActive, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?)`,
    [id, name, isActive, at(T0), at(T0)]
  );
}

function plan(id = "p1", { code = "go", creditUsd = 250, durationDays = 30, limits = null } = {}) {
  db.run(
    `INSERT INTO plans(id, code, name, priceNanoUsd, creditNanoUsd, durationDays, isActive, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [id, code, code.toUpperCase(), USD(10), USD(creditUsd), durationDays, at(T0), at(T0)]
  );
  if (limits) db.run(`UPDATE plans SET limits = ? WHERE id = ?`, [JSON.stringify(limits), id]);
}

function purchase(id = "up1", { userId = "u1", planId = "p1", creditUsd = 100, remainingUsd = 100, status = "active", hours = 720, limits = null } = {}) {
  db.run(
    `INSERT INTO userPlans(id, userId, planId, orderId, source, creditTotalNanoUsd, creditRemainingNanoUsd, startsAt, expiresAt, status, priority, limits, createdAt)
     VALUES(?, ?, ?, NULL, 'purchase', ?, ?, ?, ?, ?, NULL, ?, ?)`,
    [id, userId, planId, USD(creditUsd), USD(remainingUsd), at(T0), at(T0 + hours * 3_600_000), status,
      limits ? JSON.stringify(limits) : null, at(T0)]
  );
}

function ledgerCount() {
  return Number(db.get(`SELECT COUNT(*) AS n FROM creditLedger`)?.n ?? 0);
}

function auditRows(action = null) {
  return action
    ? db.all(`SELECT * FROM userAuditLog WHERE action = ? ORDER BY id`, [action])
    : db.all(`SELECT * FROM userAuditLog ORDER BY id`);
}

function purchases() {
  return Number(db.get(`SELECT COUNT(*) AS n FROM userPlans`)?.n ?? 0);
}

// ── validateReason ─────────────────────────────────────────────────────────

test("validateReason enforces 3–500 characters after trimming", () => {
  assert.equal(actions.validateReason("ab"), null);
  assert.equal(actions.validateReason("   ab   "), null);
  assert.equal(actions.validateReason("abc"), "abc");
  assert.equal(actions.validateReason("  abc  "), "abc");
  assert.equal(actions.validateReason("x".repeat(500)), "x".repeat(500));
  assert.equal(actions.validateReason("x".repeat(501)), null);
  assert.equal(actions.validateReason(undefined), null);
});

// ── Grant plan ─────────────────────────────────────────────────────────────

test("grantPlan creates a purchase, snapshots limits and audits", () => {
  user();
  plan("p-go", { limits: [{ hours: 5, maxNanoUsd: USD(20) }] });

  const result = db.transaction(() =>
    actions.grantPlanSync(db, "u1", { planId: "p-go", reason: REASON, actor: ACTOR, now: at(T0) })
  );
  assert.equal(result.ok, true);
  assert.equal(purchases(), 1);

  const row = db.get(`SELECT * FROM userPlans WHERE id = ?`, [result.userPlan.id]);
  assert.equal(row.source, "admin");
  assert.equal(row.status, "active");
  assert.equal(row.priority, null);
  assert.deepEqual(JSON.parse(row.limits), [{ hours: 5, maxNanoUsd: USD(20) }]);
  assert.equal(row.creditRemainingNanoUsd, USD(250));

  const ledger = db.all(`SELECT * FROM creditLedger WHERE userPlanId = ?`, [row.id]);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].kind, "grant");
  assert.equal(ledger[0].deltaNanoUsd, USD(250));

  assert.equal(auditRows("plan_granted").length, 1);
  assert.equal(auditRows("plan_granted")[0].actor, ACTOR);
  assert.equal(auditRows("plan_granted")[0].reason, REASON);
});

test("grantPlan without a reason writes nothing", () => {
  user();
  plan("p-go");
  const result = db.transaction(() => actions.grantPlanSync(db, "u1", { planId: "p-go", reason: "" }));
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(purchases(), 0);
  assert.equal(ledgerCount(), 0);
  assert.equal(auditRows().length, 0);
});

// ── Grant credit ───────────────────────────────────────────────────────────

test("grantCredit creates a credit-only purchase with no limits", () => {
  user();
  const result = db.transaction(() =>
    actions.grantCreditSync(db, "u1", { amountNanoUsd: USD(25), durationDays: 30, reason: REASON, actor: ACTOR, now: at(T0) })
  );
  assert.equal(result.ok, true);

  const row = db.get(`SELECT * FROM userPlans WHERE id = ?`, [result.userPlan.id]);
  assert.equal(row.planId, null);
  assert.equal(row.source, "admin");
  assert.equal(row.limits, null);
  assert.equal(row.creditRemainingNanoUsd, USD(25));
  assert.equal(auditRows("credit_granted").length, 1);
});

test("grantCredit rejects an out-of-range amount and a missing reason", () => {
  user();

  const tooSmall = db.transaction(() =>
    actions.grantCreditSync(db, "u1", { amountNanoUsd: USD(0.001), durationDays: 30, reason: REASON })
  );
  assert.equal(tooSmall.status, 400);

  const tooBig = db.transaction(() =>
    actions.grantCreditSync(db, "u1", { amountNanoUsd: USD(10_001), durationDays: 30, reason: REASON })
  );
  assert.equal(tooBig.status, 400);

  const badDays = db.transaction(() =>
    actions.grantCreditSync(db, "u1", { amountNanoUsd: USD(10), durationDays: 0, reason: REASON })
  );
  assert.equal(badDays.status, 400);

  // Spec scenario: "Grant credit with an empty reason" → 400 and no purchase.
  const noReason = db.transaction(() =>
    actions.grantCreditSync(db, "u1", { amountNanoUsd: USD(10), durationDays: 30, reason: "" })
  );
  assert.equal(noReason.status, 400);

  assert.equal(purchases(), 0);
  assert.equal(ledgerCount(), 0);
  assert.equal(auditRows().length, 0);
});

// ── Extend ─────────────────────────────────────────────────────────────────

test("extend adds days to a live purchase", () => {
  user();
  plan();
  purchase("up1", { hours: 24 });

  const before = db.get(`SELECT expiresAt FROM userPlans WHERE id = 'up1'`).expiresAt;
  const result = db.transaction(() =>
    actions.extendPlanSync(db, "u1", "up1", { days: 10, reason: REASON, actor: ACTOR, now: at(T0) })
  );
  assert.equal(result.ok, true);

  const after = db.get(`SELECT expiresAt FROM userPlans WHERE id = 'up1'`).expiresAt;
  assert.ok(new Date(after) > new Date(before));
  assert.equal(auditRows("plan_extended").length, 1);
});

test("extend accepts an explicit later date and refuses an earlier one", () => {
  user();
  plan();
  purchase("up1", { hours: 720 });

  const target = at(T0 + 60 * DAY);
  const ok = db.transaction(() =>
    actions.extendPlanSync(db, "u1", "up1", { expiresAt: target, reason: REASON, now: at(T0) })
  );
  assert.equal(ok.ok, true);
  assert.equal(db.get(`SELECT expiresAt FROM userPlans WHERE id = 'up1'`).expiresAt, target);

  const past = db.transaction(() =>
    actions.extendPlanSync(db, "u1", "up1", { expiresAt: at(T0 - DAY), reason: REASON, now: at(T0) })
  );
  assert.equal(past.status, 400);
  // Unchanged by the refusal.
  assert.equal(db.get(`SELECT expiresAt FROM userPlans WHERE id = 'up1'`).expiresAt, target);
});

test("extend refuses a revoked purchase", () => {
  user();
  plan();
  purchase("up1", { status: "revoked" });
  const result = db.transaction(() =>
    actions.extendPlanSync(db, "u1", "up1", { days: 5, reason: REASON, now: at(T0) })
  );
  assert.equal(result.status, 409);
  assert.equal(auditRows("plan_extended").length, 0);
});

// ── Adjust credit ──────────────────────────────────────────────────────────

test("adjust adds and removes credit with one ledger row and one audit row", () => {
  user();
  plan();
  purchase("up1", { creditUsd: 100, remainingUsd: 20 });

  const up = db.transaction(() =>
    actions.adjustCreditSync(db, "u1", "up1", { deltaNanoUsd: USD(10), reason: REASON, actor: ACTOR, now: at(T0) })
  );
  assert.equal(up.ok, true);
  assert.equal(up.creditRemainingNanoUsd, USD(30));

  const down = db.transaction(() =>
    actions.adjustCreditSync(db, "u1", "up1", { deltaNanoUsd: -USD(5), reason: REASON, actor: ACTOR, now: at(T0) })
  );
  assert.equal(down.ok, true);
  assert.equal(down.creditRemainingNanoUsd, USD(25));

  const ledger = db.all(`SELECT * FROM creditLedger WHERE kind = 'adjust' ORDER BY id`);
  assert.equal(ledger.length, 2);
  assert.equal(ledger[0].deltaNanoUsd, USD(10));
  assert.equal(ledger[1].deltaNanoUsd, -USD(5));
  assert.equal(auditRows("credit_adjusted").length, 2);
});

test("adjust below zero is refused and nothing changes", () => {
  user();
  plan();
  purchase("up1", { creditUsd: 100, remainingUsd: 20 });

  const result = db.transaction(() =>
    actions.adjustCreditSync(db, "u1", "up1", { deltaNanoUsd: -USD(30), reason: REASON, now: at(T0) })
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);

  assert.equal(db.get(`SELECT creditRemainingNanoUsd FROM userPlans WHERE id = 'up1'`).creditRemainingNanoUsd, USD(20));
  assert.equal(ledgerCount(), 0);
  assert.equal(auditRows().length, 0);
});

test("adjust to zero exhausts; adjust back above zero reactivates while unexpired", () => {
  user();
  plan();
  purchase("up1", { creditUsd: 100, remainingUsd: 20 });

  const toZero = db.transaction(() =>
    actions.adjustCreditSync(db, "u1", "up1", { deltaNanoUsd: -USD(20), reason: REASON, now: at(T0) })
  );
  assert.equal(toZero.status, "exhausted");

  const back = db.transaction(() =>
    actions.adjustCreditSync(db, "u1", "up1", { deltaNanoUsd: USD(15), reason: REASON, now: at(T0) })
  );
  assert.equal(back.status, "active");
  assert.equal(back.creditRemainingNanoUsd, USD(15));
});

test("adjust refuses a zero delta and a missing reason", () => {
  user();
  plan();
  purchase("up1");

  assert.equal(db.transaction(() => actions.adjustCreditSync(db, "u1", "up1", { deltaNanoUsd: 0, reason: REASON })).status, 400);
  assert.equal(db.transaction(() => actions.adjustCreditSync(db, "u1", "up1", { deltaNanoUsd: USD(1), reason: "" })).status, 400);
  assert.equal(ledgerCount(), 0);
});

// ── Edit purchase limits ───────────────────────────────────────────────────

test("setPurchaseLimits validates against the purchase and deletes removed windows", () => {
  user();
  plan();
  purchase("up1", { creditUsd: 100, remainingUsd: 80, limits: [{ hours: 5, maxNanoUsd: USD(20) }, { hours: 168, maxNanoUsd: USD(50) }] });
  db.run(`INSERT INTO userPlanWindows(userPlanId, hours, startedAt, spentNanoUsd) VALUES('up1', 5, ?, ?)`, [at(T0), USD(12)]);
  db.run(`INSERT INTO userPlanWindows(userPlanId, hours, startedAt, spentNanoUsd) VALUES('up1', 168, ?, ?)`, [at(T0), USD(40)]);

  const result = db.transaction(() =>
    actions.setPurchaseLimitsSync(db, "u1", "up1", {
      limits: [{ hours: 5, maxNanoUsd: USD(15) }, { hours: 24, maxNanoUsd: USD(40) }],
      reason: REASON,
      actor: ACTOR,
      now: at(T0),
    })
  );
  assert.equal(result.ok, true);

  assert.deepEqual(JSON.parse(db.get(`SELECT limits FROM userPlans WHERE id = 'up1'`).limits), [
    { hours: 5, maxNanoUsd: USD(15) },
    { hours: 24, maxNanoUsd: USD(40) },
  ]);
  // Kept length keeps its spend; removed length's state is gone.
  assert.equal(db.get(`SELECT spentNanoUsd FROM userPlanWindows WHERE userPlanId = 'up1' AND hours = 5`).spentNanoUsd, USD(12));
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM userPlanWindows WHERE hours = 168`)?.n, 0);

  assert.equal(auditRows("plan_limits_changed").length, 1);
  // No money moved.
  assert.equal(ledgerCount(), 0);
});

test("setPurchaseLimits rejects a limit at or above the purchase credit", () => {
  user();
  plan();
  purchase("up1", { creditUsd: 100 });

  const result = db.transaction(() =>
    actions.setPurchaseLimitsSync(db, "u1", "up1", {
      limits: [{ hours: 5, maxNanoUsd: USD(100) }],
      reason: REASON,
      now: at(T0),
    })
  );
  assert.equal(result.status, 400);
  assert.equal(db.get(`SELECT limits FROM userPlans WHERE id = 'up1'`).limits, null);
  assert.equal(auditRows().length, 0);
});

// ── Revoke ─────────────────────────────────────────────────────────────────

test("revoke zeroes credit, writes -remaining as revoke, and audits", () => {
  user();
  plan();
  purchase("up1", { creditUsd: 250, remainingUsd: 120 });
  db.run(`INSERT INTO userPlanWindows(userPlanId, hours, startedAt, spentNanoUsd) VALUES('up1', 5, ?, ?)`, [at(T0), USD(10)]);

  const result = db.transaction(() =>
    actions.revokePlanSync(db, "u1", "up1", { reason: "Hoàn tiền ngoài hệ thống", actor: ACTOR, now: at(T0) })
  );
  assert.equal(result.ok, true);
  assert.equal(result.revokedNanoUsd, USD(120));

  const row = db.get(`SELECT status, creditRemainingNanoUsd FROM userPlans WHERE id = 'up1'`);
  assert.equal(row.status, "revoked");
  assert.equal(row.creditRemainingNanoUsd, 0);

  const ledger = db.all(`SELECT * FROM creditLedger WHERE kind = 'revoke'`);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].deltaNanoUsd, -USD(120));

  const audit = auditRows("plan_revoked");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].reason, "Hoàn tiền ngoài hệ thống");
  assert.equal(JSON.parse(audit[0].details).revokedNanoUsd, USD(120));

  // Window state is gone with the purchase.
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM userPlanWindows`)?.n, 0);
});

test("revoke requires a reason and refuses an already revoked purchase", () => {
  user();
  plan();
  purchase("up1", { remainingUsd: 50 });

  assert.equal(db.transaction(() => actions.revokePlanSync(db, "u1", "up1", { reason: "" })).status, 400);
  assert.equal(db.get(`SELECT status FROM userPlans WHERE id = 'up1'`).status, "active");

  db.transaction(() => actions.revokePlanSync(db, "u1", "up1", { reason: REASON, now: at(T0) }));
  assert.equal(
    db.transaction(() => actions.revokePlanSync(db, "u1", "up1", { reason: REASON, now: at(T0) })).status,
    409
  );
  // Exactly one revoke row from the successful call.
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM creditLedger WHERE kind = 'revoke'`)?.n, 1);
});

// ── Account-level ──────────────────────────────────────────────────────────

test("changeGroup only accepts an active group", () => {
  user();
  group("g-live", { name: "Live", isActive: 1 });
  group("g-dead", { name: "Dead", isActive: 0 });

  const ok = db.transaction(() =>
    actions.changeGroupSync(db, "u1", { groupId: "g-live", reason: REASON, actor: ACTOR, now: at(T0) })
  );
  assert.equal(ok.ok, true);
  assert.equal(db.get(`SELECT groupId FROM users WHERE id = 'u1'`).groupId, "g-live");

  const dead = db.transaction(() =>
    actions.changeGroupSync(db, "u1", { groupId: "g-dead", reason: REASON, now: at(T0) })
  );
  assert.equal(dead.status, 400);
  assert.equal(db.get(`SELECT groupId FROM users WHERE id = 'u1'`).groupId, "g-live");

  assert.equal(auditRows("group_changed").length, 1);
});

test("changing status to suspended revokes every session and audits once", () => {
  user();
  db.run(
    `INSERT INTO userSessions(id, userId, tokenHash, createdAt, expiresAt, revokedAt) VALUES('s1','u1','h1',?,?,NULL)`,
    [at(T0), at(T0 + DAY)]
  );

  const result = db.transaction(() =>
    actions.changeStatusSync(db, "u1", { status: "suspended", reason: "Gian lận thanh toán", actor: ACTOR, before: "active", now: at(T0) })
  );
  assert.equal(result.ok, true);
  assert.equal(result.revokedSessions, 1);
  assert.equal(db.get(`SELECT status FROM users WHERE id = 'u1'`).status, "suspended");
  assert.ok(db.get(`SELECT revokedAt FROM userSessions WHERE id = 's1'`).revokedAt);

  const audit = auditRows("status_changed");
  assert.equal(audit.length, 1);
  assert.deepEqual(JSON.parse(audit[0].details).after, { status: "suspended" });
});

test("changing status to an invalid value is refused", () => {
  user();
  const result = db.transaction(() =>
    actions.changeStatusSync(db, "u1", { status: "deleted", reason: REASON, now: at(T0) })
  );
  assert.equal(result.status, 400);
  assert.equal(db.get(`SELECT status FROM users WHERE id = 'u1'`).status, "active");
  assert.equal(auditRows().length, 0);
});

test("setNote saves the note without requiring a reason", () => {
  user();
  const result = db.transaction(() =>
    actions.setNoteSync(db, "u1", { adminNote: "  Đã gọi điện xác nhận  ", actor: ACTOR, now: at(T0) })
  );
  assert.equal(result.ok, true);
  assert.equal(result.adminNote, "Đã gọi điện xác nhận");
  assert.equal(db.get(`SELECT adminNote FROM users WHERE id = 'u1'`).adminNote, "Đã gọi điện xác nhận");
  assert.equal(auditRows("note_changed").length, 1);
});

test("setNote refuses a note over 2000 characters", () => {
  user();
  const result = db.transaction(() =>
    actions.setNoteSync(db, "u1", { adminNote: "x".repeat(2001), now: at(T0) })
  );
  assert.equal(result.status, 400);
  assert.equal(db.get(`SELECT adminNote FROM users WHERE id = 'u1'`).adminNote, null);
});

test("resetPassword stores the hash, revokes sessions and never logs the password", () => {
  user();
  db.run(
    `INSERT INTO userSessions(id, userId, tokenHash, createdAt, expiresAt, revokedAt) VALUES('s1','u1','h1',?,?,NULL)`,
    [at(T0), at(T0 + DAY)]
  );

  const result = db.transaction(() =>
    actions.resetPasswordSync(db, "u1", {
      passwordHash: "new-hash",
      reason: "Khách quên mật khẩu, xác minh qua điện thoại",
      actor: ACTOR,
      before: "old-hash",
      now: at(T0),
    })
  );
  assert.equal(result.ok, true);
  assert.equal(result.revokedSessions, 1);
  assert.equal(db.get(`SELECT passwordHash FROM users WHERE id = 'u1'`).passwordHash, "new-hash");
  assert.ok(db.get(`SELECT revokedAt FROM userSessions WHERE id = 's1'`).revokedAt);

  const audit = auditRows("password_reset");
  assert.equal(audit.length, 1);
  // N1: a password reset is an account change, so it carries a reason and a
  // before/after like every other action (spec exempts only Edit note and Reorder).
  assert.equal(audit[0].reason, "Khách quên mật khẩu, xác minh qua điện thoại");
  const details = JSON.parse(audit[0].details);
  assert.deepEqual(Object.keys(details).sort(), ["after", "before", "revokedSessions"]);
  assert.equal(details.before.hasPassword, true);
  assert.equal(details.after.hasPassword, true);
  assert.ok(details.after.passwordChangedAt);
  assert.equal(details.revokedSessions, 1);

  // Never the secret, in either hash.
  assert.equal(String(audit[0].details).includes("new-hash"), false);
  assert.equal(String(audit[0].details).includes("old-hash"), false);
});

test("N1: resetPassword without a reason is refused and writes nothing", () => {
  user();
  const result = db.transaction(() =>
    actions.resetPasswordSync(db, "u1", { passwordHash: "new-hash", reason: "", actor: ACTOR, now: at(T0) })
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(db.get(`SELECT passwordHash FROM users WHERE id = 'u1'`).passwordHash, "hash");
  assert.equal(auditRows("password_reset").length, 0);
});

// ── Apply to active ────────────────────────────────────────────────────────

test("applyLimitsToActiveSync touches only active purchases and audits each user", () => {
  user("u1");
  user("u2");
  user("u3");
  plan("p-go");
  purchase("up-1", { userId: "u1", planId: "p-go", status: "active" });
  purchase("up-2", { userId: "u2", planId: "p-go", status: "active" });
  purchase("up-3", { userId: "u3", planId: "p-go", status: "expired" });

  const result = db.transaction(() =>
    actions.applyLimitsToActiveSync(db, "p-go", [{ hours: 5, maxNanoUsd: USD(10) }], { actor: ACTOR, planCode: "go", now: at(T0) })
  );
  assert.equal(result.affectedCount, 2);

  assert.deepEqual(JSON.parse(db.get(`SELECT limits FROM userPlans WHERE id = 'up-1'`).limits), [{ hours: 5, maxNanoUsd: USD(10) }]);
  assert.deepEqual(JSON.parse(db.get(`SELECT limits FROM userPlans WHERE id = 'up-2'`).limits), [{ hours: 5, maxNanoUsd: USD(10) }]);
  assert.equal(db.get(`SELECT limits FROM userPlans WHERE id = 'up-3'`).limits, null);

  const audit = auditRows("plan_limits_changed");
  assert.equal(audit.length, 2);
  assert.ok(audit.every((row) => row.reason === "Áp dụng hạn mức mới của gói go"));
});

test("applyLimitsToActiveSync refuses limits that break the plan's own rules", () => {
  user();
  plan("p-go", { creditUsd: 250 });
  purchase("up-1", { planId: "p-go" });

  const result = db.transaction(() =>
    actions.applyLimitsToActiveSync(db, "p-go", [{ hours: 5, maxNanoUsd: USD(250) }], { actor: ACTOR, now: at(T0) })
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(db.get(`SELECT limits FROM userPlans WHERE id = 'up-1'`).limits, null);
  assert.equal(auditRows().length, 0);
});
