// Affiliate vouchers at checkout and the referred-buyer bonus
// (change affiliate-credit-vouchers; spec affiliate-program "Voucher at checkout",
// "Referred-buyer bonus").
//
// Pins:
//   * a voucher lowers the amount to pay, is held by its pending order, is spent
//     when the order is approved, and a hold lapses when the order expires;
//   * cross-currency vouchers convert at the admin rate;
//   * an order brought to 0 is approved at once;
//   * commission is computed on the discounted amount;
//   * a referred buyer gets X% bonus credit (credit plans) or X% off (unlimited
//     plans) on their first N paid orders only.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-aff-vouchers-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const orders = await import("../src/lib/billing/orders.js");
const checkout = await import("../src/lib/payments/checkout.js");
const core = await import("../src/lib/affiliate/core.js");
const vouchers = await import("../src/lib/affiliate/vouchers.js");
const billingRepo = await import("../src/lib/db/repos/billingRepo.js");
const { NANO } = await import("../src/shared/utils/money.js");

let db;
const USD = (n) => Math.round(n * NANO);
const T0 = Date.UTC(2026, 10, 1, 10, 0, 0);
const at = (ms) => new Date(ms).toISOString();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const SETTINGS = { paymentCodePrefix: "DR", paymentOrderTtlMinutes: 30, allowManualOrders: true };

before(async () => { db = await getAdapter(); });
after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  for (const t of ["affiliateVouchers", "affiliateLedger", "affiliateCommissions", "affiliates", "userPlanWindows",
    "creditLedger", "userPlans", "orders", "paymentProviders", "plans", "users", "userAuditLog", "settings"]) {
    try { db.run(`DELETE FROM ${t}`); } catch { /* partial schema */ }
  }
});

function user(id, { referredByUserId = null } = {}) {
  db.run(
    `INSERT INTO users(id, email, passwordHash, status, overdraftNanoUsd, referredByUserId, createdAt, updatedAt)
     VALUES(?, ?, 'x', 'active', 0, ?, ?, ?)`,
    [id, `${id}@test.local`, referredByUserId, at(T0), at(T0)]
  );
  return id;
}

function settings(patch) {
  const row = db.get(`SELECT data FROM settings WHERE id = 1`);
  const next = { ...(row ? JSON.parse(row.data) : {}), ...patch };
  db.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, [JSON.stringify(next)]);
}

function plan(id, { priceVnd = 250000, priceUsd = 10, creditUsd = 10, unlimited = 0, active = 1 } = {}) {
  db.run(
    `INSERT INTO plans(id, code, name, priceNanoUsd, priceVnd, creditNanoUsd, unlimitedCredit, durationDays, isActive, isPurchasable, rpm, tpm, limits, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, 30, ?, 1, 30, 100000, '[]', ?, ?)`,
    [id, id, id.toUpperCase(), USD(priceUsd), priceVnd, unlimited ? 0 : USD(creditUsd), unlimited, active, at(T0), at(T0)]
  );
  const row = db.get(`SELECT * FROM plans WHERE id = ?`, [id]);
  return {
    ...row, isActive: true, isPurchasable: true, unlimitedCredit: Boolean(unlimited),
    priceNanoUsd: Number(row.priceNanoUsd), priceVnd: Number(row.priceVnd), creditNanoUsd: Number(row.creditNanoUsd),
    durationDays: 30, limits: [],
  };
}

function providers() {
  for (const [id, kind] of [["v1", "sepay"], ["b1", "binance"]]) {
    db.run(
      `INSERT INTO paymentProviders(id, kind, name, isActive, sortOrder, config, secrets, pollIntervalSeconds, createdAt, updatedAt)
       VALUES(?, ?, ?, 1, 0, ?, '{}', 30, ?, ?)`,
      [id, kind, id, JSON.stringify({ accountNumber: "1017588888", bankBin: "970436", bankName: "VCB" }), at(T0), at(T0)]
    );
  }
}

/** Program on, an affiliate "aff" with a VND balance, a template plan. */
function setup({ balanceVnd = 500000, buyerBonusBp = 0, buyerBonusMaxOrders = 1 } = {}) {
  settings({
    affiliateEnabled: true, affiliateDefaultRateBp: 1000, affiliateDefaultMaxOrders: 0, affiliateHoldDays: 0,
    affiliateVndPerUsd: 25000, affiliateCreditDays: 30, affiliateMinRedeemVnd: 0, affiliateMinRedeemUsdNano: 0,
    affiliateBuyerBonusBp: buyerBonusBp, affiliateBuyerBonusMaxOrders: buyerBonusMaxOrders,
  });
  user("aff");
  db.transaction(() => core.ensureAffiliateSync(db, "aff"));
  if (balanceVnd) {
    db.run(`INSERT INTO affiliateLedger(userId, currency, delta, kind, createdAt) VALUES('aff', 'VND', ?, 'adjust', ?)`, [balanceVnd, at(T0)]);
  }
  plan("tpl", { active: 0, creditUsd: 0 });
  settings({ affiliateCreditPlanId: "tpl" });
  providers();
}

function voucher(amount, currency = "VND") {
  return db.transaction(() => vouchers.createVoucherSync(db, "aff", { currency, amount }, { now: at(T0) }));
}

function buy(userId, planRow, method, { voucherCode = null, now = T0 } = {}) {
  return db.transaction(() => checkout.createGatewayOrderSync(db, {
    userId, plan: planRow, method, settings: SETTINGS, nowIso: at(now), voucherCode,
  }));
}

const orderRow = (id) => db.get(`SELECT * FROM orders WHERE id = ?`, [id]);
const voucherRow = (id) => db.get(`SELECT * FROM affiliateVouchers WHERE id = ?`, [id]);

test("a voucher lowers a VietQR order, is held, and is spent on approval", () => {
  setup();
  user("cust");
  const go = plan("go");
  const v = voucher(100000);

  const created = buy("cust", go, "vietqr", { voucherCode: v.code.toLowerCase() });
  assert.equal(created.ok, true);
  assert.equal(created.order.payAmount, 150000);
  assert.equal(created.order.voucherDiscount, 100000);
  assert.equal(voucherRow(v.id).heldByOrderId, created.order.id);

  // Held by a pending order: nobody else can use it meanwhile.
  user("other");
  const second = buy("other", go, "vietqr", { voucherCode: v.code });
  assert.equal(second.ok, false);
  assert.equal(second.code, "bad_voucher");

  db.transaction(() => orders.approveOrderSync(db, created.order.id, { now: at(T0 + MIN) }));
  const spent = voucherRow(v.id);
  assert.equal(spent.status, "used");
  assert.equal(spent.usedByUserId, "cust");
  assert.equal(spent.usedOrderId, created.order.id);
});

test("an expired order releases its hold; a used voucher cannot be used again", () => {
  setup();
  user("cust");
  const go = plan("go");
  const v = voucher(50000);
  const first = buy("cust", go, "vietqr", { voucherCode: v.code });
  db.run(`UPDATE orders SET status = 'expired' WHERE id = ?`, [first.order.id]);

  const again = buy("cust", go, "vietqr", { voucherCode: v.code, now: T0 + DAY });
  assert.equal(again.ok, true, "the hold lapsed with the expired order");
  db.transaction(() => orders.approveOrderSync(db, again.order.id, { now: at(T0 + DAY + MIN) }));
  const third = buy("cust", go, "vietqr", { voucherCode: v.code, now: T0 + 2 * DAY });
  assert.equal(third.ok, false);
  // An expired holder also blocks cancelling: an admin may still approve it late.
  const v2 = voucher(10000);
  const held = buy("cust", go, "vietqr", { voucherCode: v2.code, now: T0 + 3 * DAY });
  db.run(`UPDATE orders SET status = 'expired' WHERE id = ?`, [held.order.id]);
  assert.throws(() => db.transaction(() => vouchers.cancelVoucherSync(db, "aff", v2.id)), (e) => e.reason === "held");
});

test("cross-currency vouchers convert at the admin rate", () => {
  setup();
  db.run(`INSERT INTO affiliateLedger(userId, currency, delta, kind, createdAt) VALUES('aff', 'USD', ?, 'adjust', ?)`, [USD(5), at(T0)]);
  user("cust");
  const go = plan("go", { priceVnd: 250000, priceUsd: 10 });
  const usdVoucher = voucher(USD(2), "USD");
  const vnd = buy("cust", go, "vietqr", { voucherCode: usdVoucher.code });
  assert.equal(vnd.order.voucherDiscount, 50000, "$2 at 25,000đ/$ = 50,000đ");
  assert.equal(vnd.order.payAmount, 200000);

  user("cust2");
  const vndVoucher = voucher(125000);
  const usdt = buy("cust2", go, "binance", { voucherCode: vndVoucher.code });
  assert.equal(usdt.order.voucherDiscount, USD(5), "125,000đ at 25,000đ/$ = $5");
  assert.equal(usdt.order.payAmount, USD(5));
});

test("an order covered by the voucher is approved at once; the remainder is lost", () => {
  setup();
  user("cust");
  const go = plan("go", { priceVnd: 250000 });
  const v = voucher(300000);
  const created = buy("cust", go, "vietqr", { voucherCode: v.code });
  assert.equal(created.ok, true);
  assert.equal(created.order.payAmount, 0);
  assert.equal(created.order.status, "paid");
  assert.equal(created.order.approvedBy, "voucher");
  assert.equal(voucherRow(v.id).status, "used");
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM userPlans WHERE userId = 'cust' AND source = 'purchase'`).n, 1);
});

test("the manual path applies the voucher too, in USD", async () => {
  setup();
  db.run(`INSERT INTO affiliateLedger(userId, currency, delta, kind, createdAt) VALUES('aff', 'USD', ?, 'adjust', ?)`, [USD(5), at(T0)]);
  user("cust");
  plan("go", { priceUsd: 10 });
  const v = voucher(USD(3), "USD");
  const order = await billingRepo.createOrder({ userId: "cust", planId: "go", voucherCode: v.code });
  const row = orderRow(order.id);
  assert.equal(row.payCurrency, "USD");
  assert.equal(Number(row.payAmount), USD(7));
  assert.equal(Number(row.amountNanoUsd), USD(7));
  assert.equal(row.voucherId, v.id);
  await assert.rejects(billingRepo.createOrder({ userId: "cust", planId: "go", voucherCode: "NOPE" }), /Voucher không hợp lệ/);
});

test("commission is computed on the discounted amount", () => {
  setup();
  user("ref");
  db.transaction(() => core.ensureAffiliateSync(db, "ref"));
  user("cust", { referredByUserId: "ref" });
  const go = plan("go", { priceVnd: 250000 });
  const v = voucher(50000);
  const created = buy("cust", go, "vietqr", { voucherCode: v.code });
  const approved = db.transaction(() => orders.approveOrderSync(db, created.order.id, { now: at(T0 + MIN) }));
  assert.equal(Number(approved.commission.baseAmount), 200000);
  assert.equal(Number(approved.commission.amount), 20000);
});

test("a referred buyer gets X% bonus credit on the first N credit-plan orders only", () => {
  setup({ buyerBonusBp: 1000, buyerBonusMaxOrders: 1 });
  user("cust", { referredByUserId: "aff" });
  const go = plan("go", { creditUsd: 10 });

  const first = buy("cust", go, "vietqr");
  const approved = db.transaction(() => orders.approveOrderSync(db, first.order.id, { now: at(T0 + MIN) }));
  assert.ok(approved.buyerBonus, "bonus granted");
  const bonus = db.get(`SELECT * FROM userPlans WHERE userId = 'cust' AND source = 'referral_bonus'`);
  assert.equal(Number(bonus.creditTotalNanoUsd), USD(1), "10% of $10");
  assert.equal(bonus.planId, "tpl");
  assert.equal(bonus.expiresAt, at(T0 + MIN + 30 * DAY));

  const second = buy("cust", go, "vietqr", { now: T0 + DAY });
  const again = db.transaction(() => orders.approveOrderSync(db, second.order.id, { now: at(T0 + DAY + MIN) }));
  assert.equal(again.buyerBonus, null, "only the first order");
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM userPlans WHERE userId = 'cust' AND source = 'referral_bonus'`).n, 1);
});

test("an unlimited plan gets X% off at checkout instead, within the first N", () => {
  setup({ buyerBonusBp: 1000, buyerBonusMaxOrders: 1 });
  user("cust", { referredByUserId: "aff" });
  const pro = plan("pro", { priceVnd: 500000, unlimited: 1 });

  const first = buy("cust", pro, "vietqr");
  assert.equal(first.order.payAmount, 450000);
  assert.equal(first.order.referralDiscountBp, 1000);
  // A second pending order cannot also take the "first order" discount.
  const parallel = buy("cust", pro, "vietqr", { now: T0 + MIN });
  assert.equal(parallel.order.payAmount, 500000);

  const approved = db.transaction(() => orders.approveOrderSync(db, first.order.id, { now: at(T0 + 2 * MIN) }));
  assert.equal(approved.buyerBonus, null, "no bonus credit on an unlimited plan");
});

test("no bonus while the program is off, the referrer is blocked or there is no template", () => {
  setup({ buyerBonusBp: 1000, buyerBonusMaxOrders: 0 });
  user("cust", { referredByUserId: "aff" });
  const go = plan("go", { creditUsd: 10 });
  const pro = plan("pro", { priceVnd: 500000, unlimited: 1 });

  db.run(`UPDATE affiliates SET status = 'blocked' WHERE userId = 'aff'`);
  assert.equal(buy("cust", pro, "vietqr").order.payAmount, 500000);
  db.run(`UPDATE affiliates SET status = 'active' WHERE userId = 'aff'`);

  settings({ affiliateCreditPlanId: "" });
  const o = buy("cust", go, "vietqr", { now: T0 + MIN });
  assert.equal(db.transaction(() => orders.approveOrderSync(db, o.order.id, { now: at(T0 + 2 * MIN) })).buyerBonus, null);

  settings({ affiliateCreditPlanId: "tpl", affiliateEnabled: false });
  assert.equal(buy("cust", pro, "vietqr", { now: T0 + 3 * MIN }).order.payAmount, 500000);
});

// ── Review fixes ────────────────────────────────────────────────────────────

test("a voucher cannot be refunded while ANY order that used it may still be approved", () => {
  setup();
  user("cust");
  const go = plan("go");
  const v = voucher(50000);
  // O1 used it and expired; O2 took the hold over and was cancelled.
  const o1 = buy("cust", go, "vietqr", { voucherCode: v.code });
  db.run(`UPDATE orders SET status = 'expired' WHERE id = ?`, [o1.order.id]);
  const o2 = buy("cust", go, "vietqr", { voucherCode: v.code, now: T0 + DAY });
  db.run(`UPDATE orders SET status = 'cancelled' WHERE id = ?`, [o2.order.id]);
  assert.equal(voucherRow(v.id).heldByOrderId, o2.order.id);
  // O1 can still be approved late, so the voucher must not go back to the wallet.
  assert.throws(() => db.transaction(() => vouchers.cancelVoucherSync(db, "aff", v.id)), (e) => e.reason === "held");
});

test("refunding an order takes its buyer bonus back", async () => {
  setup({ buyerBonusBp: 1000, buyerBonusMaxOrders: 1 });
  user("cust", { referredByUserId: "aff" });
  const go = plan("go", { creditUsd: 10 });
  const o = buy("cust", go, "vietqr");
  db.transaction(() => orders.approveOrderSync(db, o.order.id, { now: at(T0 + MIN) }));
  const bonus = db.get(`SELECT * FROM userPlans WHERE userId = 'cust' AND source = 'referral_bonus'`);
  assert.equal(bonus.orderId, o.order.id);

  await billingRepo.refundOrder(o.order.id, { adminId: "admin", adminNote: "test" });
  const after = db.get(`SELECT status, creditRemainingNanoUsd FROM userPlans WHERE id = ?`, [bonus.id]);
  assert.equal(after.status, "refunded");
  assert.equal(Number(after.creditRemainingNanoUsd), 0);
});

test("with N = 1 a pending discounted order and a paid credit order cannot both be rewarded", () => {
  setup({ buyerBonusBp: 1000, buyerBonusMaxOrders: 1 });
  user("cust", { referredByUserId: "aff" });
  const pro = plan("pro", { priceVnd: 500000, unlimited: 1 });
  const go = plan("go", { creditUsd: 10 });
  const discounted = buy("cust", pro, "vietqr");
  assert.equal(discounted.order.referralDiscountBp, 1000);
  const credit = buy("cust", go, "vietqr", { now: T0 + MIN });
  const approved = db.transaction(() => orders.approveOrderSync(db, credit.order.id, { now: at(T0 + 2 * MIN) }));
  assert.equal(approved.buyerBonus, null, "the discount already used the one reward");
});

test("a discounted USDT amount is rounded up to a cent, never above the price", () => {
  setup({ buyerBonusBp: 333, buyerBonusMaxOrders: 0 });
  user("cust", { referredByUserId: "aff" });
  const pro = plan("pro", { priceUsd: 10, unlimited: 1 });
  const o = buy("cust", pro, "binance");
  // 10 USD - 3.33% = 9.667 → 9.67
  assert.equal(o.order.payAmount, 9_670_000_000);
  assert.equal(o.order.payAmount % 10_000_000, 0);
});
