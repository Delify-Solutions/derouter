// Gift-code tests against a real throwaway SQLite database.
//
// These pin the rules that protect revenue and fairness:
//   * a code is single-use by default, and the limit is enforced, not implied
//   * perUserLimit actually allows N redemptions (it used to be capped at 1 by
//     a UNIQUE constraint that silently overrode the setting)
//   * maxRedemptions is a global cap across accounts
//   * an expired window, a disabled code, and an unknown code are rejected
//   * code input is forgiving: lower case, spaces and missing dashes all resolve
//   * a rejected redemption grants nothing and leaves no ledger row
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-gift-test-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const gifts = await import("../src/lib/db/repos/giftRepo.js");
const billing = await import("../src/lib/db/repos/billingRepo.js");
const { NANO } = await import("../src/shared/utils/money.js");

let db;
const USD = (n) => Math.round(n * NANO);

function reset() {
  for (const t of [
    "giftRedemptions",
    "giftCodes",
    "creditLedger",
    "userPlans",
    "orders",
    "plans",
    "users",
  ]) {
    try {
      db.run(`DELETE FROM ${t}`);
    } catch {
      /* partial schema */
    }
  }
}

function insertUser(id, email) {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
     VALUES(?, ?, 'x', 'T', NULL, 'active', 0, ?, ?)`,
    [id, email, now, now],
  );
  return id;
}

function insertPlan(id, code) {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO plans(id, code, name, description, priceNanoUsd, creditNanoUsd, durationDays, isActive, sortOrder, createdAt, updatedAt)
     VALUES(?, ?, ?, NULL, ?, ?, 30, 1, 0, ?, ?)`,
    [id, code, code, USD(10), USD(25), now, now],
  );
  return id;
}

function userPlanCount(userId) {
  return db.get(`SELECT COUNT(*) AS c FROM userPlans WHERE userId = ?`, [userId]).c;
}

function chargeRows(userId) {
  return db.all(`SELECT * FROM creditLedger WHERE userId = ? AND kind = 'charge'`, [userId]);
}

before(async () => {
  db = await getAdapter();
  reset();
});

after(() => {
  try {
    db?.close?.();
  } catch {
    /* ignore */
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("a credit code grants the stated amount once", async () => {
  reset();
  const u = insertUser("gu1", "g1@test.local");
  const gift = await gifts.createGiftCode({
    grantKind: "credit",
    creditNanoUsd: USD(5),
    durationDays: 7,
    maxRedemptions: 1,
    perUserLimit: 1,
  });

  const res = db.transaction(() => gifts.redeemGiftCode(db, { userId: u, code: gift.code }));

  assert.equal(res.ok, true);
  assert.equal(res.userPlan.creditRemainingNanoUsd, USD(5), "the granted plan holds the credit");

  const wallet = await billing.walletSummary(u);
  assert.equal(wallet.availableNanoUsd, USD(5), "the credit must reach the wallet");

  const grants = db.all(`SELECT * FROM userPlans WHERE userId = ?`, [u]);
  assert.equal(grants.length, 1);
  assert.equal(grants[0].source, "gift", "the grant must be attributed to a gift");
});

test("a single-use code cannot be redeemed twice by the same account", async () => {
  reset();
  const u = insertUser("gu2", "g2@test.local");
  const gift = await gifts.createGiftCode({
    grantKind: "credit",
    creditNanoUsd: USD(5),
    durationDays: 7,
    maxRedemptions: 10,
    perUserLimit: 1,
  });

  const first = db.transaction(() => gifts.redeemGiftCode(db, { userId: u, code: gift.code }));
  const second = db.transaction(() => gifts.redeemGiftCode(db, { userId: u, code: gift.code }));

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.reason, "already_redeemed");
  assert.equal(userPlanCount(u), 1, "the rejected attempt must grant nothing");
});

// Regression: `perUserLimit` was accepted by the API but a UNIQUE(giftId,userId)
// constraint silently capped every code at one redemption per account.
test("perUserLimit actually allows N redemptions per account", async () => {
  reset();
  const u = insertUser("gu3", "g3@test.local");
  const gift = await gifts.createGiftCode({
    grantKind: "credit",
    creditNanoUsd: USD(1),
    durationDays: 7,
    maxRedemptions: 10,
    perUserLimit: 3,
  });

  for (let i = 1; i <= 3; i++) {
    const res = db.transaction(() => gifts.redeemGiftCode(db, { userId: u, code: gift.code }));
    assert.equal(res.ok, true, `redemption ${i} of 3 must succeed`);
    assert.equal(userPlanCount(u), i, `redemption ${i} must add exactly one grant`);
  }

  const fourth = db.transaction(() => gifts.redeemGiftCode(db, { userId: u, code: gift.code }));
  assert.equal(fourth.ok, false);
  assert.equal(fourth.reason, "already_redeemed");
  assert.equal(userPlanCount(u), 3, "the limit must stop at exactly 3");

  const wallet = await billing.walletSummary(u);
  assert.equal(wallet.availableNanoUsd, USD(3), "three grants of $1");
});

test("maxRedemptions caps the code across all accounts", async () => {
  reset();
  const a = insertUser("gu4a", "g4a@test.local");
  const b = insertUser("gu4b", "g4b@test.local");
  const c = insertUser("gu4c", "g4c@test.local");
  const gift = await gifts.createGiftCode({
    grantKind: "credit",
    creditNanoUsd: USD(1),
    durationDays: 7,
    maxRedemptions: 2,
    perUserLimit: 1,
  });

  const r1 = db.transaction(() => gifts.redeemGiftCode(db, { userId: a, code: gift.code }));
  const r2 = db.transaction(() => gifts.redeemGiftCode(db, { userId: b, code: gift.code }));
  const r3 = db.transaction(() => gifts.redeemGiftCode(db, { userId: c, code: gift.code }));

  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r3.ok, false);
  assert.equal(r3.reason, "exhausted", "the third account is rejected by the global cap");

  const row = db.get(`SELECT * FROM giftCodes WHERE id = ?`, [gift.id]);
  assert.equal(row.redeemedCount, 2, "the counter must not exceed the cap");
});

test("an expired code is rejected", async () => {
  reset();
  const u = insertUser("gu5", "g5@test.local");
  const past = new Date(Date.now() - 3600_000).toISOString();
  const gift = await gifts.createGiftCode({
    grantKind: "credit",
    creditNanoUsd: USD(5),
    durationDays: 7,
    maxRedemptions: 1,
    perUserLimit: 1,
    expiresAt: past,
  });

  const res = db.transaction(() => gifts.redeemGiftCode(db, { userId: u, code: gift.code }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, "not_active");
  assert.equal(userPlanCount(u), 0, "an expired code must grant nothing");
});

test("a disabled code is rejected", async () => {
  reset();
  const u = insertUser("gu6", "g6@test.local");
  const gift = await gifts.createGiftCode({
    grantKind: "credit",
    creditNanoUsd: USD(5),
    durationDays: 7,
    maxRedemptions: 1,
    perUserLimit: 1,
  });
  await gifts.updateGiftCode(gift.id, { isActive: false });

  const res = db.transaction(() => gifts.redeemGiftCode(db, { userId: u, code: gift.code }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, "not_found");
});

test("an unknown code is rejected without touching the wallet", async () => {
  reset();
  const u = insertUser("gu7", "g7@test.local");
  const res = db.transaction(() =>
    gifts.redeemGiftCode(db, { userId: u, code: "ZZZZ-ZZZZ-ZZZZ-ZZZZ" }),
  );
  assert.equal(res.ok, false);
  assert.equal(res.reason, "not_found");

  const wallet = await billing.walletSummary(u);
  assert.equal(wallet.availableNanoUsd, 0);
  assert.deepEqual(chargeRows(u), []);
});

test("code input is forgiving: lower case, spaces and missing dashes resolve", async () => {
  reset();
  const u = insertUser("gu8", "g8@test.local");
  const gift = await gifts.createGiftCode({
    grantKind: "credit",
    creditNanoUsd: USD(2),
    durationDays: 7,
    maxRedemptions: 1,
    perUserLimit: 1,
  });

  const messy = `  ${gift.code.toLowerCase().replace(/-/g, "")}  `;
  const res = db.transaction(() => gifts.redeemGiftCode(db, { userId: u, code: messy }));
  assert.equal(res.ok, true, `"${messy}" should resolve to ${gift.code}`);

  const wallet = await billing.walletSummary(u);
  assert.equal(wallet.availableNanoUsd, USD(2));
});

test("a plan gift grants that plan, not raw credit", async () => {
  reset();
  const u = insertUser("gu9", "g9@test.local");
  // A plan with credit but a duration shorter than the default.
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO plans(id, code, name, description, priceNanoUsd, creditNanoUsd, durationDays, isActive, sortOrder, createdAt, updatedAt)
     VALUES('p-gift', 'giftplan', 'Gift Plan', NULL, ?, ?, 3, 1, 0, ?, ?)`,
    [USD(0), USD(7), now, now],
  );

  const gift = await gifts.createGiftCode({
    grantKind: "plan",
    planId: "p-gift",
    maxRedemptions: 1,
    perUserLimit: 1,
  });

  const res = db.transaction(() => gifts.redeemGiftCode(db, { userId: u, code: gift.code }));
  assert.equal(res.ok, true);

  const grant = db.get(`SELECT * FROM userPlans WHERE userId = ?`, [u]);
  assert.equal(grant.planId, "p-gift");
  assert.equal(grant.creditRemainingNanoUsd, USD(7));

  // The granted plan carries the plan's own duration.
  const days = (new Date(grant.expiresAt) - new Date(grant.startsAt)) / 86_400_000;
  assert.ok(Math.abs(days - 3) < 0.01, `expected 3 days, got ${days}`);
});

test("a gift credit pays down an existing overdraft first", async () => {
  reset();
  const u = insertUser("gu10", "g10@test.local");
  db.run(`UPDATE users SET overdraftNanoUsd = ? WHERE id = ?`, [USD(2), u]);

  const gift = await gifts.createGiftCode({
    grantKind: "credit",
    creditNanoUsd: USD(5),
    durationDays: 7,
    maxRedemptions: 1,
    perUserLimit: 1,
  });

  const res = db.transaction(() => gifts.redeemGiftCode(db, { userId: u, code: gift.code }));
  assert.equal(res.ok, true);
  assert.equal(res.appliedToOverdraftNanoUsd, USD(2), "debt is settled before credit lands");

  const user = db.get(`SELECT * FROM users WHERE id = ?`, [u]);
  assert.equal(user.overdraftNanoUsd, 0);

  const wallet = await billing.walletSummary(u);
  assert.equal(wallet.availableNanoUsd, USD(3), "only the remainder becomes spendable");
});
