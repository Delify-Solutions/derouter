// Gift codes given straight to accounts, and top-up plans gifted as an amount
// (spec gift-codes).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-gift-assign-"));
// DATA_DIR must be set before the DB driver is imported.
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const repo = await import("../src/lib/db/repos/billingRepo.js");
const gifts = await import("../src/lib/db/repos/giftRepo.js");
const { topupCreditForAmount } = await import("../src/lib/billing/topup.js");

let db;
const USD = (n) => Math.round(n * 1e9);

before(async () => { db = await getAdapter(); });
after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(() => {
  for (const table of ["giftRedemptions", "giftCodes", "creditLedger", "userPlans", "plans", "users", "userAuditLog"]) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* table may not exist */ }
  }
  const now = new Date().toISOString();
  for (const id of ["u1", "u2", "u3"]) {
    db.run(
      `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
       VALUES(?, ?, 'x', NULL, NULL, 'active', 0, ?, ?)`,
      [id, `${id}@Test.local`, now, now]
    );
  }
});

let seq = 0;
const plan = (overrides = {}) => repo.createPlan({
  code: `g-${++seq}`, name: `G ${seq}`, priceNanoUsd: USD(0.4), priceVnd: 10000, creditNanoUsd: USD(10), durationDays: 30, ...overrides,
});
const topupPlan = () => plan({ allowCustomAmount: true, limits: [{ hours: 5, maxNanoUsd: USD(5) }] });

test("topup credit for an amount follows the plan's rate, without customer bounds", () => {
  assert.equal(topupCreditForAmount({ priceVnd: 10000, creditNanoUsd: USD(10) }, 250000), USD(250));
  assert.equal(topupCreditForAmount({ priceVnd: 10000, creditNanoUsd: USD(10) }, 1), 1_000_000);
  assert.equal(topupCreditForAmount({ priceVnd: 0, creditNanoUsd: USD(10) }, 10000), 0);
  assert.equal(topupCreditForAmount({ priceVnd: 10000, creditNanoUsd: 0, unlimitedCredit: 1 }, 10000), 0);
});

test("a top-up plan gifted as an amount grants that amount's credit with the plan's limits", async () => {
  const p = await topupPlan();
  const code = await gifts.createGiftCode({ planId: p.id, amountVnd: 250000 });
  assert.equal(code.amountVnd, 250000);
  assert.equal(code.amountCreditNanoUsd, USD(250));

  const result = gifts.redeemGiftCode(db, { userId: "u1", code: code.code });
  assert.equal(result.ok, true);
  assert.equal(result.userPlan.creditTotalNanoUsd, USD(250));
  assert.equal(result.userPlan.planId, p.id);
  assert.match(result.userPlan.limits, /"hours":5/);
});

test("an amount is refused for a plan that is not sold by custom amount, or without a plan", async () => {
  const fixed = await plan();
  await assert.rejects(() => gifts.createGiftCode({ planId: fixed.id, amountVnd: 50000 }), /nạp số tiền tùy ý/);
  await assert.rejects(() => gifts.createGiftCode({ creditNanoUsd: USD(5), durationDays: 30, amountVnd: 50000 }), /Số tiền/);
  const p = await topupPlan();
  await assert.rejects(() => gifts.createGiftCode({ planId: p.id, amountVnd: -5 }), /Số tiền/);
});

test("a top-up plan gift without an amount grants the plan's own credit", async () => {
  const p = await topupPlan();
  const code = await gifts.createGiftCode({ planId: p.id });
  const result = gifts.redeemGiftCode(db, { userId: "u1", code: code.code });
  assert.equal(result.userPlan.creditTotalNanoUsd, USD(10));
});

test("assigning gives the code to each account as a recorded redemption", async () => {
  const p = await plan();
  const code = await gifts.createGiftCode({ planId: p.id, maxRedemptions: 2 });
  const out = gifts.assignGiftCodeSync(db, code.id, { userIds: ["u1"], emails: ["U2@test.LOCAL", "nobody@test.local"], actor: "admin:boss" });
  assert.equal(out.ok, true);
  assert.deepEqual(out.results.map((r) => [r.email, r.ok, r.reason ?? null]), [
    ["u1@Test.local", true, null],
    ["u2@Test.local", true, null],
    [null, false, "user_not_found"],
  ]);

  const redemptions = await gifts.listRedemptions(code.id);
  assert.equal(redemptions.length, 2);
  assert.ok(redemptions.every((r) => r.assignedBy === "admin:boss"));
  assert.equal((await gifts.getGiftCodeById(code.id)).redeemedCount, 2);
  const audit = db.all(`SELECT * FROM userAuditLog WHERE action = 'gift_assigned'`);
  assert.equal(audit.length, 2);
  const mine = await gifts.listUserRedemptions("u1");
  assert.equal(mine[0].assignedByAdmin, true);
});

test("assigning respects the code's limits: total, per user and active flag", async () => {
  const p = await plan();
  const code = await gifts.createGiftCode({ planId: p.id, maxRedemptions: 1 });
  const first = gifts.assignGiftCodeSync(db, code.id, { userIds: ["u1", "u2"] });
  assert.deepEqual(first.results.map((r) => r.ok), [true, false]);
  assert.equal(first.results[1].reason, "exhausted");

  const twice = await gifts.createGiftCode({ planId: p.id, maxRedemptions: 5, perUserLimit: 1 });
  gifts.assignGiftCodeSync(db, twice.id, { userIds: ["u3"] });
  assert.equal(gifts.assignGiftCodeSync(db, twice.id, { userIds: ["u3"] }).results[0].reason, "already_redeemed");

  await gifts.updateGiftCode(twice.id, { isActive: false });
  assert.equal(gifts.assignGiftCodeSync(db, twice.id, { userIds: ["u2"] }).results[0].reason, "not_found");
  assert.equal(gifts.assignGiftCodeSync(db, "missing", { userIds: ["u2"] }).reason, "not_found");
  assert.equal(gifts.assignGiftCodeSync(db, twice.id, {}).reason, "no_users");
});
