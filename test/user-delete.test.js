// Cascade delete (spec admin-user-management "Cascade delete").
//
// What must die with the account: keys, sessions, verification tokens, purchases,
// window state, ledger rows, gift redemptions, audit entries and the user row.
// What must survive: the orders, which are accounting records and now carry an
// email snapshot so the buyer stays identifiable.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-userdelete-test-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const users = await import("../src/lib/db/repos/userRepo.js");
const { listAuditSync } = await import("../src/lib/billing/audit.js");
const { NANO } = await import("../src/shared/utils/money.js");

let db;
const USD = (n) => Math.round(n * NANO);
const NOW = () => new Date().toISOString();

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
    "emailVerifications",
    "users",
    "keyGroups",
  ]) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* table may not exist */ }
  }
});

function seedUser(id = "u1", email = "buyer@test.local") {
  db.run(
    `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
     VALUES(?, ?, 'hash', 'Buyer', NULL, 'active', 0, ?, ?)`,
    [id, email, NOW(), NOW()]
  );
  return { id, email };
}

test("cascade removes every owned row and keeps the orders", async () => {
  const user = seedUser("u1", "buyer@test.local");

  // Keys + sessions + verification tokens.
  db.run(
    `INSERT INTO apiKeys(id, key, name, isActive, createdAt, userId) VALUES('k1', 'secret', 'laptop', 1, ?, 'u1')`,
    [NOW()]
  );
  db.run(
    `INSERT INTO userSessions(id, userId, tokenHash, createdAt, expiresAt) VALUES('s1', 'u1', 'th1', ?, ?)`,
    [NOW(), new Date(Date.now() + 86_400_000).toISOString()]
  );
  db.run(
    `INSERT INTO emailVerifications(id, userId, tokenHash, purpose, expiresAt, createdAt) VALUES('v1', 'u1', 'vh1', 'verify_email', ?, ?)`,
    [new Date(Date.now() + 86_400_000).toISOString(), NOW()]
  );

  // A plan, its window state and ledger rows.
  db.run(
    `INSERT INTO userPlans(id, userId, planId, orderId, source, creditTotalNanoUsd, creditRemainingNanoUsd, startsAt, expiresAt, status, createdAt)
     VALUES('up1', 'u1', NULL, NULL, 'purchase', ?, ?, ?, ?, 'active', ?)`,
    [USD(10), USD(4), NOW(), new Date(Date.now() + 86_400_000).toISOString(), NOW()]
  );
  // userPlanWindows arrives with the plan queue (GĐ1); the cascade is asserted
  // against it only once the table exists, so this test never invents schema.
  const hasWindowTable = Boolean(db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='userPlanWindows'`));
  if (hasWindowTable) {
    db.run(
      `INSERT INTO userPlanWindows(userPlanId, hours, startedAt, spentNanoUsd) VALUES('up1', 5, ?, ?)`,
      [NOW(), USD(6)]
    );
  }
  db.run(
    `INSERT INTO creditLedger(userId, userPlanId, deltaNanoUsd, balanceAfterNanoUsd, kind, createdAt)
     VALUES('u1', 'up1', ?, ?, 'charge', ?)`,
    [-USD(6), USD(4), NOW()]
  );

  // Gift code + redemption.
  db.run(
    `INSERT INTO giftCodes(id, code, grantKind, maxRedemptions, redeemedCount, perUserLimit, isActive, createdAt, updatedAt)
     VALUES('g1', 'CODE-1', 'credit', 1, 1, 1, 1, ?, ?)`,
    [NOW(), NOW()]
  );
  db.run(
    `INSERT INTO giftRedemptions(id, giftId, userId, userPlanId, redeemedAt) VALUES('r1', 'g1', 'u1', 'up1', ?)`,
    [NOW()]
  );

  // An audit entry from earlier, plus two paid orders.
  db.run(
    `INSERT INTO userAuditLog(id, userId, actor, action, createdAt) VALUES('a0', 'u1', 'system', 'group_auto_assigned', ?)`,
    [NOW()]
  );
  db.run(
    `INSERT INTO plans(id, code, name, priceNanoUsd, creditNanoUsd, durationDays, isActive, createdAt, updatedAt)
     VALUES('p1', 'go', 'Go', ?, ?, 30, 1, ?, ?)`,
    [USD(10), USD(250), NOW(), NOW()]
  );
  for (const orderId of ["o1", "o2"]) {
    db.run(
      `INSERT INTO orders(id, userId, planId, amountNanoUsd, creditNanoUsd, durationDays, status, emailSnapshot, createdAt, paidAt)
       VALUES(?, 'u1', 'p1', ?, ?, 30, 'paid', 'buyer@test.local', ?, ?)`,
      [orderId, USD(10), USD(250), NOW(), NOW()]
    );
  }

  const result = await users.deleteUser("u1", { actor: "admin:ops@test.local" });
  assert.equal(result.deleted, true);
  assert.equal(result.email, "buyer@test.local");
  assert.equal(result.keyCount, 1);

  const countOf = (sql, params) => Number(db.get(sql, params)?.n ?? 0);
  assert.equal(countOf(`SELECT COUNT(*) AS n FROM users WHERE id = 'u1'`), 0);
  assert.equal(countOf(`SELECT COUNT(*) AS n FROM apiKeys WHERE userId = 'u1'`), 0);
  assert.equal(countOf(`SELECT COUNT(*) AS n FROM userSessions WHERE userId = 'u1'`), 0);
  assert.equal(countOf(`SELECT COUNT(*) AS n FROM emailVerifications WHERE userId = 'u1'`), 0);
  assert.equal(countOf(`SELECT COUNT(*) AS n FROM userPlans WHERE userId = 'u1'`), 0);
  if (hasWindowTable) {
    assert.equal(countOf(`SELECT COUNT(*) AS n FROM userPlanWindows`), 0);
  }
  assert.equal(countOf(`SELECT COUNT(*) AS n FROM creditLedger WHERE userId = 'u1'`), 0);
  assert.equal(countOf(`SELECT COUNT(*) AS n FROM giftRedemptions WHERE userId = 'u1'`), 0);

  // Orders survive, still carry the email.
  assert.equal(countOf(`SELECT COUNT(*) AS n FROM orders WHERE userId = 'u1'`), 2);
  const order = db.get(`SELECT userId, emailSnapshot FROM orders WHERE id = 'o1'`);
  assert.equal(order.emailSnapshot, "buyer@test.local");
});

test("orders still report the email through ORDER_SELECT after deletion", async () => {
  seedUser("u1", "gone@test.local");
  db.run(
    `INSERT INTO plans(id, code, name, priceNanoUsd, creditNanoUsd, durationDays, isActive, createdAt, updatedAt)
     VALUES('p1', 'go', 'Go', 10000000000, 250000000000, 30, 1, ?, ?)`,
    [NOW(), NOW()]
  );
  db.run(
    `INSERT INTO orders(id, userId, planId, amountNanoUsd, creditNanoUsd, durationDays, status, emailSnapshot, createdAt)
     VALUES('o1', 'u1', 'p1', 10000000000, 250000000000, 30, 'paid', 'gone@test.local', ?)`,
    [NOW()]
  );

  const billing = await import("../src/lib/db/repos/billingRepo.js");
  const before = await billing.getOrderById("o1");
  assert.equal(before.userEmail, "gone@test.local");

  await users.deleteUser("u1", { actor: "admin:ops" });

  // The join finds no users row, so the COALESCE falls through to the snapshot.
  const after = await billing.getOrderById("o1");
  assert.equal(after.userEmail, "gone@test.local");
});

test("exactly one user_deleted audit row survives the wipe", async () => {
  seedUser("u1", "audit@test.local");
  db.run(
    `INSERT INTO userAuditLog(id, userId, actor, action, createdAt) VALUES('a0', 'u1', 'system', 'group_auto_assigned', ?)`,
    [NOW()]
  );

  await users.deleteUser("u1", { actor: "admin:ops@test.local" });

  const rows = db.all(`SELECT * FROM userAuditLog WHERE userId = 'u1'`);
  assert.equal(rows.length, 1, "the earlier entry is wiped, the deletion is recorded");
  assert.equal(rows[0].action, "user_deleted");
  assert.equal(rows[0].actor, "admin:ops@test.local");
  const details = JSON.parse(rows[0].details);
  assert.equal(details.userId, "u1");
  assert.equal(details.email, "audit@test.local");

  const listed = listAuditSync(db, "u1");
  assert.equal(listed.total, 1);
  assert.equal(listed.entries[0].action, "user_deleted");
});

test("deleting a user that does not exist reports deleted: false", async () => {
  const result = await users.deleteUser("nope");
  assert.equal(result.deleted, false);
  assert.equal(result.email, null);
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM userAuditLog`)?.n, 0);
});
