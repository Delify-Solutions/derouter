// Affiliate program (spec affiliate-program, spec account-registration).
//
// These pin the money invariants of the program:
//   * commission accrues inside the approval transaction, exactly once per order;
//   * the first N counts a buyer's non-reversed commissions, and a refund frees
//     its slot;
//   * the currency and base amount follow the currency the customer paid in, and
//     the amount is floor(base × bp / 10000) in integer maths only;
//   * a refund reverses the commission, and a released one leaves a negative
//     balance that blocks spending;
//   * spending (credit, vouchers) debits in the same transaction, so two full-balance requests
//     cannot both succeed;
//   * a blocked, deleted or disabled referrer earns nothing.
//
// Throwaway SQLite DB; every function under test is synchronous and takes the
// adapter, so `now` is always explicit — no sleeping, no clock mocking.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-affiliate-test-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const orders = await import("../src/lib/billing/orders.js");
const affiliate = await import("../src/lib/affiliate/core.js");
const commission = await import("../src/lib/affiliate/commission.js");
const wallet = await import("../src/lib/affiliate/wallet.js");
const vouchers = await import("../src/lib/affiliate/vouchers.js");
const gift = await import("../src/lib/affiliate/gift.js");
const codes = await import("../src/lib/affiliate/codes.js");
const mask = await import("../src/lib/affiliate/mask.js");
const settingsLib = await import("../src/lib/affiliate/settings.js");
const settingsRepo = await import("../src/lib/db/repos/settingsRepo.js");
const userRepo = await import("../src/lib/db/repos/userRepo.js");
const billingRepo = await import("../src/lib/db/repos/billingRepo.js");
const giftRepo = await import("../src/lib/db/repos/giftRepo.js");
const affiliateRepo = await import("../src/lib/db/repos/affiliateRepo.js");
const reconcile = await import("../src/lib/payments/reconcile.js");
const { NANO } = await import("../src/shared/utils/money.js");

let db;
const USD = (n) => Math.round(n * NANO);

const T0 = Date.UTC(2026, 9, 29, 10, 0, 0);
const at = (ms) => new Date(ms).toISOString();
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

before(async () => { db = await getAdapter(); });

after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const CLEAN_TABLES = [
  "affiliateVouchers",
  "affiliateLedger",
  "affiliateCommissions",
  "affiliates",
  "giftRedemptions",
  "giftCodes",
  "userPlanWindows",
  "creditLedger",
  "userPlans",
  "orders",
  "plans",
  "apiKeys",
  "users",
  "userAuditLog",
  "settings",
];

beforeEach(() => {
  for (const table of CLEAN_TABLES) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* partial schema */ }
  }
});

// ── Fixtures ────────────────────────────────────────────────────────────────

function user(id, { referredByUserId = null, email = null } = {}) {
  db.run(
    `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd,
                        referredByUserId, referredAt, createdAt, updatedAt)
     VALUES(?, ?, 'x', NULL, NULL, 'active', 0, ?, ?, ?, ?)`,
    [
      id,
      email || `${id}@test.local`,
      referredByUserId,
      referredByUserId ? at(T0) : null,
      at(T0),
      at(T0),
    ]
  );
  return id;
}

function plan(id = "p1", { priceUsd = 10, priceVnd = 250000, creditUsd = 250, days = 30 } = {}) {
  db.run(
    `INSERT INTO plans(id, code, name, priceNanoUsd, priceVnd, creditNanoUsd, durationDays, isActive, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [id, id, id.toUpperCase(), USD(priceUsd), priceVnd, USD(creditUsd), days, at(T0), at(T0)]
  );
  return id;
}

function orderRow({
  id = "o1",
  userId = "buyer",
  status = "pending",
  payCurrency = "VND",
  payAmount = 250000,
  amountNanoUsd = USD(10),
  createdAt = T0,
} = {}) {
  db.run(
    `INSERT INTO orders(
       id, userId, planId, amountNanoUsd, creditNanoUsd, durationDays, status, method,
       paymentCode, payCurrency, payAmount, paymentProviderId, expiresAt, createdAt
     ) VALUES(?, ?, 'p1', ?, ?, 30, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    [
      id, userId, amountNanoUsd, USD(250), status,
      payCurrency === "USDT" ? "binance" : "vietqr",
      null, payCurrency, payAmount, at(createdAt),
    ]
  );
  return id;
}

function makeAffiliate(id = "aff", { code = null, rateBp = null, maxOrders = null, status = "active" } = {}) {
  user(id);
  const row = db.transaction(() => affiliate.ensureAffiliateSync(db, id));
  db.run(
    `UPDATE affiliates SET code = ?, rateBp = ?, maxOrders = ?, status = ? WHERE userId = ?`,
    [code || row.code, rateBp, maxOrders, status, id]
  );
  return db.get(`SELECT * FROM affiliates WHERE userId = ?`, [id]);
}

/**
 * Program settings for a test. Written through the real `settings` row so the sync
 * reader (the one order approval uses) sees exactly what an admin save would store.
 * Synchronous so a synchronous test can call it.
 */
function saveSettings(patch) {
  const row = db.get(`SELECT data FROM settings WHERE id = 1`);
  let current = {};
  try {
    current = row ? JSON.parse(row.data) || {} : {};
  } catch {
    current = {};
  }
  const next = { ...current, ...patch };
  db.run(
    `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
    [JSON.stringify(next)]
  );
}

function enableProgram(patch = {}) {
  saveSettings({
    affiliateEnabled: true,
    affiliateDefaultRateBp: 1000,
    affiliateDefaultMaxOrders: 1,
    affiliateHoldDays: 7,
    ...patch,
  });
}

function approve(orderId, ms = T0 + 5 * MIN) {
  return db.transaction(() => orders.approveOrderSync(db, orderId, { approvedBy: "admin:test", now: at(ms) }));
}

function commissions(orderId = null) {
  return orderId
    ? db.all(`SELECT * FROM affiliateCommissions WHERE orderId = ?`, [orderId])
    : db.all(`SELECT * FROM affiliateCommissions ORDER BY createdAt`);
}

function ledger(userId, currency = "VND") {
  return db.all(
    `SELECT * FROM affiliateLedger WHERE userId = ? AND currency = ? ORDER BY id`,
    [userId, currency]
  );
}

function newUserGiftCode(id = "g1", overrides = {}) {
  const now = at(T0);
  const row = {
    code: "WELC-OME1",
    grantKind: "credit",
    creditNanoUsd: USD(5),
    durationDays: 30,
    maxRedemptions: 100,
    redeemedCount: 0,
    perUserLimit: 1,
    isActive: 1,
    newUserOnly: 1,
    startsAt: null,
    expiresAt: null,
    ...overrides,
  };
  db.run(
    `INSERT INTO giftCodes(id, code, grantKind, creditNanoUsd, durationDays, maxRedemptions,
                           redeemedCount, perUserLimit, startsAt, expiresAt, isActive, newUserOnly,
                           createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, row.code, row.grantKind, row.creditNanoUsd, row.durationDays, row.maxRedemptions,
      row.redeemedCount, row.perUserLimit, row.startsAt, row.expiresAt, row.isActive, row.newUserOnly,
      now, now,
    ]
  );
  return id;
}

// ── Codes ───────────────────────────────────────────────────────────────────

test("referral code: 6 characters, unambiguous alphabet, stable per account", () => {
  enableProgram();
  const a1 = db.transaction(() => affiliate.ensureAffiliateSync(db, user("a1")));
  const a2 = db.transaction(() => affiliate.ensureAffiliateSync(db, user("a2")));

  assert.equal(a1.code.length, 6);
  assert.match(a1.code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  // The alphabet has no 0/O/1/I/L by construction.
  assert.doesNotMatch(a1.code, /[0O1IL]/);
  assert.notEqual(a1.code, a2.code, "codes are unique across accounts");

  // Opening the page twice must return the same row, not mint another code.
  const again = db.transaction(() => affiliate.ensureAffiliateSync(db, "a1"));
  assert.equal(again.code, a1.code);
  assert.equal(Number(db.get(`SELECT COUNT(*) AS n FROM affiliates`)?.n), 2);
});

test("referral codes are matched case-insensitively", () => {
  const aff = makeAffiliate("aff", { code: "K7Q2MZ" });
  enableProgram();
  assert.equal(affiliate.resolveReferrerSync(db, "k7q2mz"), "aff");
  assert.equal(affiliate.resolveReferrerSync(db, " K7Q2MZ "), "aff");
  assert.equal(affiliate.resolveReferrerSync(db, "nope12"), null);
});

test("generateReferralCode honours the requested length", () => {
  assert.equal(codes.generateReferralCode().length, 6);
  assert.equal(codes.generateReferralCode(8).length, 8);
  assert.equal(codes.normalizeReferralCode(" k7qm-2z "), "K7QM2Z");
});

test("registration and the register page take the first VALID code: ref, then cookie", () => {
  enableProgram();
  makeAffiliate("a", { code: "AAAAAA" });
  makeAffiliate("b", { code: "BBBBBB" });
  const pick = (list) => affiliate.resolveFirstReferralSync(db, list);

  assert.deepEqual(pick(["aaaaaa", "BBBBBB"]), { code: "AAAAAA", referrerId: "a" }, "ref wins when valid");
  assert.deepEqual(pick(["", "bbbbbb"]), { code: "BBBBBB", referrerId: "b" });
  // A stale or mistyped ?ref= must fall through to a valid cookie on both sides,
  // or the page would show no banner while the API still bound the account.
  assert.deepEqual(pick(["NOPE22", "BBBBBB"]), { code: "BBBBBB", referrerId: "b" });
  assert.equal(pick(["NOPE22", null]), null);
  assert.equal(pick([null, "---"]), null);

  db.run(`UPDATE affiliates SET status = 'blocked' WHERE userId = 'a'`);
  assert.deepEqual(pick(["AAAAAA", "BBBBBB"]), { code: "BBBBBB", referrerId: "b" }, "a blocked code falls through");
});

test("a click counts only when it brings a different code than the cookie", () => {
  assert.equal(affiliate.shouldCountClick("K7Q2MZ", "K7Q2MZ"), false, "same link again");
  assert.equal(affiliate.shouldCountClick("k7q2mz", "K7Q2MZ"), false, "case does not matter");
  assert.equal(affiliate.shouldCountClick("OLD111", "K7Q2MZ"), true, "a newer link replaces it");
  assert.equal(affiliate.shouldCountClick(null, "K7Q2MZ"), true, "first click");
  assert.equal(affiliate.shouldCountClick(null, ""), false);
});

// ── Attribution ─────────────────────────────────────────────────────────────

test("resolveReferrer refuses a blocked affiliate, a deleted account or a disabled program", () => {
  makeAffiliate("blocked", { code: "BLOCK1", status: "blocked" });
  makeAffiliate("gone", { code: "GONE11" });
  enableProgram();
  assert.equal(affiliate.resolveReferrerSync(db, "BLOCK1"), null, "blocked");

  db.run(`DELETE FROM users WHERE id = 'gone'`);
  assert.equal(affiliate.resolveReferrerSync(db, "GONE11"), null, "deleted account keeps no referrer");

  makeAffiliate("off", { code: "OFF111" });
  db.run(
    `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
    [JSON.stringify({ affiliateEnabled: false })]
  );
  assert.equal(affiliate.resolveReferrerSync(db, "OFF111"), null, "program off");
});

test("createUser writes the referrer in the same INSERT and refuses self/unknown referrers", async () => {
  user("referrer", { email: "ref@test.local" });
  const created = await userRepo.createUser({
    email: "new@test.local",
    passwordHash: "x",
    status: "active",
    referredByUserId: "referrer",
  });
  const row = db.get(`SELECT referredByUserId, referredAt FROM users WHERE id = ?`, [created.id]);
  assert.equal(row.referredByUserId, "referrer");
  assert.ok(row.referredAt, "referredAt is written with the referrer");

  const orphan = await userRepo.createUser({
    email: "orphan@test.local",
    passwordHash: "x",
    status: "active",
    referredByUserId: "does-not-exist",
  });
  assert.equal(db.get(`SELECT referredByUserId FROM users WHERE id = ?`, [orphan.id]).referredByUserId, null);
});

// ── Accrual ─────────────────────────────────────────────────────────────────

test("gateway/admin approval of a VND order records 10% in the same transaction", () => {
  enableProgram({ affiliateDefaultMaxOrders: 5 });
  makeAffiliate("aff", { code: "AAAAAA" });
  plan();
  user("buyer", { referredByUserId: "aff" });
  orderRow({ id: "o1", userId: "buyer", payCurrency: "VND", payAmount: 250000 });

  const result = approve("o1");
  assert.equal(result.alreadyApproved, false);
  assert.ok(result.commission, "the approval returns the commission it created");
  assert.equal(result.commission.currency, "VND");
  assert.equal(Number(result.commission.baseAmount), 250000);
  assert.equal(Number(result.commission.rateBp), 1000);
  assert.equal(Number(result.commission.amount), 25000);
  assert.equal(result.commission.status, "pending", "held by default");
  assert.equal(commissions("o1").length, 1);
  // Nothing reaches the ledger while it is held.
  assert.equal(ledger("aff").length, 0);
});

test("a duplicate approval creates exactly one commission", () => {
  enableProgram();
  makeAffiliate("aff");
  plan();
  user("buyer", { referredByUserId: "aff" });
  orderRow({ id: "o1", userId: "buyer" });

  approve("o1");
  const second = approve("o1", T0 + 10 * MIN);
  assert.equal(second.alreadyApproved, true);
  assert.equal(second.commission, null);
  assert.equal(commissions("o1").length, 1);
});

test("accruing twice for the same order row records one commission", () => {
  // The webhook/poll race at the function level: two calls, one commission. This is
  // what `orders.orderId UNIQUE` buys, independent of the early return in
  // approveOrderSync that a sequential repeat would take.
  // N = 0 so the first-N rule cannot be what stops the second call: only
  // `orderId UNIQUE` can.
  enableProgram({ affiliateDefaultMaxOrders: 0 });
  makeAffiliate("aff", { maxOrders: 0 });
  plan();
  user("buyer", { referredByUserId: "aff" });
  orderRow({ id: "o1", userId: "buyer" });
  const row = db.get(`SELECT * FROM orders WHERE id = 'o1'`);

  const first = db.transaction(() => commission.accrueCommissionSync(db, row, { now: at(T0) }));
  const second = db.transaction(() => commission.accrueCommissionSync(db, row, { now: at(T0 + MIN) }));
  assert.ok(first, "the first call records the commission");
  assert.equal(second, null, "the second is a no-op");
  assert.equal(commissions("o1").length, 1);
});

test("the gateway path (reconciler) accrues exactly once, and a repeat delivery does not", () => {
  // The poller/webhook route: ingestTransactionSync matches the memo to the order
  // and approves it through the same approveOrderSync the admin path uses.
  enableProgram({ affiliateDefaultMaxOrders: 5, affiliateHoldDays: 7 });
  makeAffiliate("aff", { maxOrders: 5 });
  plan();
  user("buyer", { referredByUserId: "aff" });
  const now = at(T0);
  db.run(
    `INSERT INTO paymentProviders(id, kind, name, isActive, sortOrder, config, secrets, pollIntervalSeconds, createdAt, updatedAt)
     VALUES('prov1', 'sepay', 'Provider prov1', 1, 0, ?, '{}', 30, ?, ?)`,
    [JSON.stringify({ accountNumber: "1017588888", bankBin: "970436", bankName: "Vietcombank" }), now, now]
  );
  // The reconciler only matches an order that names this provider and is still
  // payable, so the fixture carries the same fields a checkout writes.
  orderRow({ id: "o1", userId: "buyer", payCurrency: "VND", payAmount: 250000 });
  db.run(
    `UPDATE orders SET paymentCode = 'DR8K3Q7MZP', paymentProviderId = 'prov1', expiresAt = ? WHERE id = 'o1'`,
    [at(T0 + 30 * (60 * 1000))]
  );

  const provider = { id: "prov1", kind: "sepay", config: {} };
  const tx = {
    externalId: "ext-1", direction: "in", amount: 250000, currency: "VND",
    content: "MBVCB.DR8K3Q7MZP.CT tu 0123", occurredAt: at(T0 + 5 * MIN), raw: { id: "ext-1" },
  };
  const first = db.transaction(() => reconcile.ingestTransactionSync(db, {
    provider, tx, via: "poll", nowIso: at(T0 + 6 * MIN), settings: { paymentCodePrefix: "DR" },
  }));
  assert.equal(first.outcome, "matched");
  assert.equal(commissions("o1").length, 1);
  assert.equal(db.get(`SELECT status FROM orders WHERE id = 'o1'`).status, "paid");

  // The same delivery again: a duplicate transaction, no second commission.
  const second = db.transaction(() => reconcile.ingestTransactionSync(db, {
    provider, tx, via: "webhook", nowIso: at(T0 + 7 * MIN), settings: { paymentCodePrefix: "DR" },
  }));
  assert.equal(second.outcome, "duplicate");
  assert.equal(commissions("o1").length, 1);
});

test("a late approval of an expired order still accrues", () => {
  enableProgram({ affiliateDefaultMaxOrders: 5 });
  makeAffiliate("aff", { maxOrders: 5 });
  plan();
  user("buyer", { referredByUserId: "aff" });
  orderRow({ id: "o1", userId: "buyer" });
  db.run(`UPDATE orders SET status = 'expired' WHERE id = 'o1'`);

  const result = db.transaction(() =>
    orders.approveOrderSync(db, "o1", { approvedBy: "admin:test", now: at(T0 + DAY), allowExpired: true })
  );
  assert.equal(result.alreadyApproved, false);
  assert.ok(result.commission, "the admin resolving a late payment earns the commission");
  assert.equal(commissions("o1").length, 1);
});

test("an unreferred buyer records no commission", () => {
  enableProgram();
  makeAffiliate("aff");
  plan();
  user("buyer");
  orderRow({ id: "o1", userId: "buyer" });
  const result = approve("o1");
  assert.equal(result.commission, null);
  assert.equal(commissions().length, 0);
});

test("a self-referral records no commission", () => {
  enableProgram();
  makeAffiliate("aff", { maxOrders: 0 });
  plan();
  db.run(`UPDATE users SET referredByUserId = 'aff' WHERE id = 'aff'`);
  orderRow({ id: "o1", userId: "aff" });
  approve("o1");
  assert.equal(commissions().length, 0);
});

test("N = 1: only the first paid order earns", () => {
  enableProgram({ affiliateDefaultMaxOrders: 1, affiliateHoldDays: 0 });
  makeAffiliate("aff");
  plan();
  user("buyer", { referredByUserId: "aff" });
  orderRow({ id: "o1", userId: "buyer" });
  orderRow({ id: "o2", userId: "buyer" });

  approve("o1");
  approve("o2", T0 + 6 * MIN);
  assert.deepEqual(commissions().map((c) => c.orderId), ["o1"]);
});

test("N = 5: the first five of six orders earn, the sixth does not", () => {
  enableProgram({ affiliateDefaultMaxOrders: 5, affiliateHoldDays: 0 });
  makeAffiliate("aff", { maxOrders: 5 });
  plan();
  user("buyer", { referredByUserId: "aff" });
  for (let i = 1; i <= 6; i += 1) {
    orderRow({ id: `o${i}`, userId: "buyer" });
    approve(`o${i}`, T0 + i * MIN);
  }
  assert.equal(commissions().length, 5);
  assert.equal(Number(db.get(`SELECT COUNT(*) AS n FROM affiliateCommissions WHERE orderId = 'o6'`)?.n), 0);
});

test("N = 0 means every order earns", () => {
  enableProgram({ affiliateDefaultMaxOrders: 0, affiliateHoldDays: 0 });
  makeAffiliate("aff", { maxOrders: 0 });
  plan();
  user("buyer", { referredByUserId: "aff" });
  for (let i = 1; i <= 8; i += 1) {
    orderRow({ id: `o${i}`, userId: "buyer" });
    approve(`o${i}`, T0 + i * MIN);
  }
  assert.equal(commissions().length, 8);
});

test("a refunded commission frees the slot for the buyer's next order", async () => {
  enableProgram({ affiliateDefaultMaxOrders: 1, affiliateHoldDays: 7 });
  makeAffiliate("aff", { maxOrders: 1 });
  plan();
  user("buyer", { referredByUserId: "aff" });
  orderRow({ id: "o1", userId: "buyer" });
  approve("o1");

  await billingRepo.refundOrder("o1", { adminId: "admin", adminNote: "test refund" });
  assert.equal(commissions("o1")[0].status, "reversed");

  orderRow({ id: "o2", userId: "buyer" });
  approve("o2", T0 + 20 * MIN);
  assert.equal(commissions("o2").length, 1, "the freed slot earns again");
  assert.equal(Number(commissions("o2")[0].amount), 25000);
});

test("CTV override beats the default, and a later change does not rewrite recorded rows", () => {
  enableProgram({ affiliateDefaultRateBp: 1000, affiliateDefaultMaxOrders: 5 });
  makeAffiliate("aff", { rateBp: 2500, maxOrders: 5 });
  plan();
  user("buyer", { referredByUserId: "aff" });
  orderRow({ id: "o1", userId: "buyer", payAmount: 200000 });

  approve("o1");
  assert.equal(Number(commissions("o1")[0].amount), 50000, "25% of 200,000đ");

  db.run(`UPDATE affiliates SET rateBp = 500 WHERE userId = 'aff'`);
  assert.equal(Number(commissions("o1")[0].amount), 50000, "history is not rewritten");
});

test("clearing an override falls back to the program default", () => {
  enableProgram({ affiliateDefaultRateBp: 1000 });
  const row = makeAffiliate("aff", { rateBp: 2500 });
  const merged = settingsLib.readAffiliateSettingsSync(db);
  assert.equal(affiliate.effectiveTermsSync(row, merged).rateBp, 2500);
  db.run(`UPDATE affiliates SET rateBp = NULL WHERE userId = 'aff'`);
  const cleared = db.get(`SELECT * FROM affiliates WHERE userId = 'aff'`);
  assert.equal(affiliate.effectiveTermsSync(cleared, merged).rateBp, 1000);
});

// ── Currency and base amount ────────────────────────────────────────────────

test("USDT order: 10 USDT at 1500 bp earns $1.50 in nano-USD", () => {
  enableProgram({ affiliateDefaultRateBp: 1500, affiliateDefaultMaxOrders: 1, affiliateHoldDays: 0 });
  makeAffiliate("aff");
  plan();
  user("buyer", { referredByUserId: "aff" });
  orderRow({
    id: "o1",
    userId: "buyer",
    payCurrency: "USDT",
    payAmount: 10 * NANO,
    amountNanoUsd: USD(10),
  });

  approve("o1");
  const row = commissions("o1")[0];
  assert.equal(row.currency, "USD");
  assert.equal(Number(row.baseAmount), 10 * NANO);
  assert.equal(Number(row.amount), 1.5 * NANO);
});

test("manual order with no pay currency uses amountNanoUsd", () => {
  enableProgram({ affiliateDefaultRateBp: 1000, affiliateDefaultMaxOrders: 1, affiliateHoldDays: 0 });
  makeAffiliate("aff");
  plan();
  user("buyer", { referredByUserId: "aff" });
  orderRow({ id: "o1", userId: "buyer", payCurrency: null, payAmount: null, amountNanoUsd: USD(20) });

  approve("o1");
  const row = commissions("o1")[0];
  assert.equal(row.currency, "USD");
  assert.equal(Number(row.baseAmount), USD(20));
  assert.equal(Number(row.amount), USD(2));
});

test("rounding is floor: 99,999đ at 1000 bp earns 9,999đ", () => {
  enableProgram({ affiliateDefaultRateBp: 1000, affiliateDefaultMaxOrders: 1, affiliateHoldDays: 0 });
  makeAffiliate("aff");
  plan();
  user("buyer", { referredByUserId: "aff" });
  orderRow({ id: "o1", userId: "buyer", payAmount: 99999 });

  approve("o1");
  assert.equal(Number(commissions("o1")[0].amount), 9999);
});

test("an order with no positive base amount records no commission", () => {
  // A 0đ order (a 100%-discount checkout, or a row whose payAmount is NULL and
  // whose list price is 0) must not create a zero-commission row.
  enableProgram({ affiliateDefaultMaxOrders: 5 });
  makeAffiliate("aff", { maxOrders: 5 });
  plan();
  user("buyer", { referredByUserId: "aff" });
  orderRow({ id: "o1", userId: "buyer", payCurrency: "VND", payAmount: 0 });
  orderRow({ id: "o2", userId: "buyer", payCurrency: "USD", payAmount: null, amountNanoUsd: 0 });

  assert.equal(approve("o1").commission, null);
  assert.equal(approve("o2", T0 + MIN).commission, null);
  assert.equal(commissions().length, 0);
});

test("the rate multiplication uses BigInt above 2^53", () => {
  // A base whose product with the rate exceeds 2^53 while the floored result is
  // still a safe integer: exact BigInt maths and float maths disagree here, so
  // this pins the implementation, not just the formula.
  const base = Number.MAX_SAFE_INTEGER;
  const floatProduct = base * 10000;
  assert.ok(floatProduct > Number.MAX_SAFE_INTEGER, "fixture really overflows the safe range");
  assert.equal(commission.commissionAmount(base, 10000), base, "BigInt keeps it exact");
  assert.notEqual(Math.floor(floatProduct / 10000), base, "float maths would have rounded it away");
  assert.equal(commission.commissionAmount(base, 5000), Number(BigInt(base) * 5000n / 10000n));
  assert.equal(commission.commissionAmount(base, 1234), Number(BigInt(base) * 1234n / 10000n));
  assert.equal(commission.commissionAmount(0, 5000), 0);
  assert.equal(commission.commissionAmount(-5, 5000), 0);

  // …and the accrual path uses the same function on a real order.
  enableProgram({ affiliateDefaultRateBp: 1234, affiliateDefaultMaxOrders: 0, affiliateHoldDays: 0 });
  makeAffiliate("aff", { maxOrders: 0, rateBp: 1234 });
  plan();
  user("buyer", { referredByUserId: "aff" });
  orderRow({ id: "o1", userId: "buyer", payCurrency: "USD", payAmount: base, amountNanoUsd: base });
  approve("o1");
  assert.equal(Number(commissions("o1")[0].amount), Number(BigInt(base) * 1234n / 10000n));
});

// ── Hold, release and reversal ──────────────────────────────────────────────

test("a held commission is pending and not spendable, then releases when due", () => {
  enableProgram({ affiliateDefaultHoldDays: undefined, affiliateDefaultMaxOrders: 5, affiliateHoldDays: 7 });
  makeAffiliate("aff", { maxOrders: 5 });
  plan();
  user("buyer", { referredByUserId: "aff" });
  orderRow({ id: "o1", userId: "buyer" });
  approve("o1", T0);

  const early = db.transaction(() => wallet.walletSync(db, "aff", at(T0 + 3 * DAY)));
  assert.equal(early.VND.pending, 25000);
  assert.equal(early.VND.available, 0);

  const late = db.transaction(() => wallet.walletSync(db, "aff", at(T0 + 7 * DAY + MIN)));
  assert.equal(late.VND.pending, 0);
  assert.equal(late.VND.available, 25000);
  assert.equal(late.VND.earned, 25000);
  assert.equal(commissions("o1")[0].status, "available");
  assert.equal(ledger("aff").length, 1, "releasing writes exactly one ledger row");
});

test("release is idempotent: two reads do not double-credit", () => {
  enableProgram({ affiliateHoldDays: 0 });
  makeAffiliate("aff");
  plan();
  user("buyer", { referredByUserId: "aff" });
  orderRow({ id: "o1", userId: "buyer" });
  approve("o1", T0);

  db.transaction(() => wallet.walletSync(db, "aff", at(T0 + MIN)));
  db.transaction(() => wallet.walletSync(db, "aff", at(T0 + 2 * MIN)));
  assert.equal(ledger("aff").length, 1);
  assert.equal(Number(db.get(`SELECT SUM(delta) AS s FROM affiliateLedger WHERE userId='aff'`)?.s), 25000);
});

test("refund during hold reverses without touching the balance", async () => {
  enableProgram({ affiliateHoldDays: 7 });
  makeAffiliate("aff");
  plan();
  user("buyer", { referredByUserId: "aff" });
  orderRow({ id: "o1", userId: "buyer" });
  approve("o1");

  await billingRepo.refundOrder("o1", { adminId: "admin", adminNote: "held refund" });
  assert.equal(commissions("o1")[0].status, "reversed");
  assert.equal(ledger("aff").length, 0, "a held commission never reached the ledger");

  // Reversing an already reversed commission is a no-op, even called directly.
  const again = db.transaction(() => commission.reverseCommissionForOrderSync(db, "o1", { now: at(T0 + 2 * DAY) }));
  assert.equal(again.reversed, false);
  assert.equal(ledger("aff").length, 0);

  const after = db.transaction(() => wallet.walletSync(db, "aff", at(T0 + 30 * DAY)));
  assert.equal(after.VND.available, 0);
  assert.equal(after.VND.earned, 0, "a reversed commission was never earned");
  assert.equal(after.VND.pending, 0);
  const audit = db.get(
    `SELECT * FROM userAuditLog WHERE userId = 'aff' AND action = 'affiliate_commission_reversed'`
  );
  assert.ok(audit, "reversal is audited on the affiliate's account");
});

test("refund after release leaves a negative balance that blocks spending", async () => {
  enableProgram({ affiliateHoldDays: 0, affiliateMinRedeemVnd: 0, affiliateMinRedeemUsdNano: 0 });
  makeAffiliate("aff");
  plan();
  user("buyer", { referredByUserId: "aff" });
  orderRow({ id: "o1", userId: "buyer" });
  approve("o1", T0);

  // Released at accrual (holdDays 0), then spent on a voucher.
  db.transaction(() => vouchers.createVoucherSync(db, "aff", { currency: "VND", amount: 25000 }, { now: at(T0 + MIN) }));

  await billingRepo.refundOrder("o1", { adminId: "admin", adminNote: "post-spend refund" });

  const after = db.transaction(() => wallet.walletSync(db, "aff", at(T0 + 3 * MIN)));
  assert.equal(after.VND.available, -25000);
  assert.equal(db.get(`SELECT status FROM affiliateVouchers`).status, "active", "a created voucher is not taken back");

  assert.throws(
    () => db.transaction(() => vouchers.createVoucherSync(db, "aff", { currency: "VND", amount: 1000 }, { now: at(T0 + 4 * MIN) })),
    (error) => error.reason === "negative_balance"
  );
});

// ── Program switch, block, deletion ─────────────────────────────────────────

test("a disabled program accrues nothing", () => {
  makeAffiliate("aff");
  plan();
  user("buyer", { referredByUserId: "aff" });
  orderRow({ id: "o1", userId: "buyer" });

  db.run(
    `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
    [JSON.stringify({ affiliateEnabled: false })]
  );
  assert.equal(approve("o1").commission, null);
  assert.equal(commissions().length, 0);
});

test("a blocked affiliate earns no new commission", () => {
  enableProgram({ affiliateDefaultMaxOrders: 5 });
  makeAffiliate("aff");
  plan();
  user("buyer", { referredByUserId: "aff" });
  orderRow({ id: "o1", userId: "buyer" });

  db.run(`UPDATE affiliates SET status = 'blocked' WHERE userId = 'aff'`);
  assert.equal(approve("o1").commission, null, "blocked before approval");
  assert.equal(commissions().length, 0);

  db.run(`UPDATE affiliates SET status = 'active' WHERE userId = 'aff'`);
  orderRow({ id: "o2", userId: "buyer" });
  assert.ok(approve("o2", T0 + 6 * MIN).commission, "unblocked earns again while within N");
});

test("first N counts PAID orders: one paid while blocked still uses its place", () => {
  // N = 1. The buyer's first order is paid while the affiliate is blocked, so it
  // earns nothing; unblocking must not turn the second order into a "first" one.
  enableProgram({ affiliateDefaultMaxOrders: 1, affiliateHoldDays: 0 });
  makeAffiliate("aff");
  plan();
  user("buyer", { referredByUserId: "aff" });
  orderRow({ id: "o1", userId: "buyer" });
  db.run(`UPDATE affiliates SET status = 'blocked' WHERE userId = 'aff'`);
  approve("o1");

  db.run(`UPDATE affiliates SET status = 'active' WHERE userId = 'aff'`);
  orderRow({ id: "o2", userId: "buyer" });
  assert.equal(approve("o2", T0 + 6 * MIN).commission, null);
  assert.equal(commissions().length, 0);
});

test("first N counts PAID orders: one paid while the program was off still uses its place", () => {
  enableProgram({ affiliateDefaultMaxOrders: 1, affiliateHoldDays: 0 });
  makeAffiliate("aff");
  plan();
  user("buyer", { referredByUserId: "aff" });
  orderRow({ id: "o1", userId: "buyer" });
  saveSettings({ affiliateEnabled: false });
  approve("o1");

  saveSettings({ affiliateEnabled: true });
  orderRow({ id: "o2", userId: "buyer" });
  assert.equal(approve("o2", T0 + 6 * MIN).commission, null);
});

test("an admin-set referrer who never opened the page still earns", async () => {
  enableProgram({ affiliateDefaultMaxOrders: 1, affiliateHoldDays: 0 });
  plan();
  user("ref");
  user("buyer");
  assert.equal(affiliate.getAffiliateSync(db, "ref"), null, "no code yet");

  const { setUserReferrer } = await import("../src/lib/db/repos/affiliateRepo.js");
  const result = await setUserReferrer("buyer", "ref", { actor: "admin:test", reason: "support ticket" });
  assert.equal(result.referredByUserId, "ref");
  assert.ok(affiliate.getAffiliateSync(db, "ref"), "the referrer now has an affiliate row");

  orderRow({ id: "o1", userId: "buyer" });
  assert.ok(approve("o1").commission, "the next paid order earns");
});

test("a deleted referrer earns nothing and the referral keeps referredByUserId", async () => {
  enableProgram();
  makeAffiliate("aff");
  plan();
  user("buyer", { referredByUserId: "aff" });
  orderRow({ id: "o1", userId: "buyer" });

  await userRepo.deleteUser("aff", { actor: "admin:test" });
  assert.equal(db.get(`SELECT referredByUserId FROM users WHERE id = 'buyer'`).referredByUserId, "aff");
  assert.equal(approve("o1").commission, null);
  assert.equal(commissions().length, 0);
});

test("deleting an account cancels its unused vouchers, keeps used ones and drops the code", async () => {
  enableProgram({ affiliateHoldDays: 0, affiliateMinRedeemVnd: 0 });
  makeAffiliate("aff");
  plan();
  user("buyer", { referredByUserId: "aff" });
  orderRow({ id: "o1", userId: "buyer" });
  approve("o1", T0);

  const unused = db.transaction(() => vouchers.createVoucherSync(db, "aff", { currency: "VND", amount: 10000 }, { now: at(T0 + MIN) }));
  const spent = db.transaction(() => vouchers.createVoucherSync(db, "aff", { currency: "VND", amount: 5000 }, { now: at(T0 + MIN) }));
  db.run(`UPDATE affiliateVouchers SET status = 'used', usedByUserId = 'buyer' WHERE id = ?`, [spent.id]);

  await userRepo.deleteUser("aff", { actor: "admin:test" });

  assert.equal(db.get(`SELECT COUNT(*) AS n FROM affiliates WHERE userId = 'aff'`)?.n, 0);
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM affiliateLedger WHERE userId = 'aff'`)?.n, 0);
  assert.equal(db.get(`SELECT status FROM affiliateVouchers WHERE id = ?`, [unused.id]).status, "cancelled");
  assert.equal(db.get(`SELECT status FROM affiliateVouchers WHERE id = ?`, [spent.id]).status, "used", "kept for accounting");
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM affiliateCommissions WHERE affiliateUserId = 'aff'`)?.n, 1, "commissions are kept");
});

test("a deleted affiliate's held commission is never released into a wallet", async () => {
  enableProgram({ affiliateHoldDays: 7 });
  makeAffiliate("aff");
  plan();
  user("buyer", { referredByUserId: "aff" });
  orderRow({ id: "o1", userId: "buyer" });
  approve("o1", T0);
  assert.equal(commissions("o1")[0].status, "pending");

  await userRepo.deleteUser("aff", { actor: "admin:test" });
  db.transaction(() => commission.releaseAllDueSync(db, at(T0 + 8 * DAY)));
  db.transaction(() => commission.releaseDueSync(db, "aff", at(T0 + 8 * DAY)));

  assert.equal(commissions("o1")[0].status, "pending", "kept for accounting, not released");
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM affiliateLedger WHERE userId = 'aff'`)?.n, 0);
});

// ── Spending: credit conversion and vouchers ─────────────────────────────────

function fundedAffiliate({ balance = 300000 } = {}) {
  enableProgram({ affiliateDefaultRateBp: 1000, affiliateDefaultMaxOrders: 5, affiliateHoldDays: 0 });
  makeAffiliate("aff", { maxOrders: 5 });
  plan();
  user("buyer", { referredByUserId: "aff" });
  // One order per 100,000đ of balance at 10%.
  let paid = 0;
  let i = 1;
  while (paid < balance) {
    orderRow({ id: `o${i}`, userId: "buyer", payAmount: 1000000 });
    approve(`o${i}`, T0 + i * MIN);
    paid += 100000;
    i += 1;
  }
}

function templatePlan(id = "tpl") {
  db.run(
    `INSERT INTO plans(id, code, name, priceNanoUsd, creditNanoUsd, durationDays, isActive, rpm, tpm, limits, createdAt, updatedAt)
     VALUES(?, ?, 'Affiliate credit', 0, 0, 30, 0, 20, 100000, ?, ?, ?)`,
    [id, id, JSON.stringify([{ hours: 5, maxNanoUsd: USD(3) }]), at(T0), at(T0)]
  );
  saveSettings({ affiliateCreditPlanId: id, affiliateVndPerUsd: 25000, affiliateCreditDays: 30 });
  return id;
}

test("VND converts at the admin rate into a separate grant with the template's limits", () => {
  fundedAffiliate();
  templatePlan();
  const first = db.transaction(() => wallet.convertToCreditSync(db, "aff", { currency: "VND", amount: 250000 }, { now: at(T0 + DAY) }));
  assert.equal(first.creditNanoUsd, 10 * NANO, "250,000đ at 25,000đ/$ = $10");
  const up = db.get(`SELECT * FROM userPlans WHERE id = ?`, [first.userPlan.id]);
  assert.equal(up.planId, "tpl");
  assert.equal(up.source, "affiliate");
  assert.equal(Number(up.creditRemainingNanoUsd), 10 * NANO);
  assert.equal(Number(up.unlimitedCredit), 0);
  assert.deepEqual(JSON.parse(up.limits), [{ hours: 5, maxNanoUsd: USD(3) }]);
  assert.equal(up.expiresAt, at(T0 + DAY + 30 * DAY));

  // A second conversion is its own purchase with its own expiry: never merged.
  const second = db.transaction(() => wallet.convertToCreditSync(db, "aff", { currency: "VND", amount: 25000 }, { now: at(T0 + 10 * DAY) }));
  assert.notEqual(second.userPlan.id, first.userPlan.id);
  assert.equal(second.userPlan.expiresAt, at(T0 + 40 * DAY));
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM userPlans WHERE userId = 'aff' AND source = 'affiliate'`).n, 2);

  const after = db.transaction(() => wallet.walletSync(db, "aff", at(T0 + 10 * DAY)));
  assert.equal(after.VND.available, 300000 - 275000);
  assert.equal(after.VND.spent, 275000);
});

test("conversion is refused without a template plan, below the minimum or above the balance", () => {
  fundedAffiliate();
  assert.throws(
    () => db.transaction(() => wallet.convertToCreditSync(db, "aff", { currency: "VND", amount: 100000 }, { now: at(T0 + DAY) })),
    (error) => error.reason === "no_template"
  );
  templatePlan();
  saveSettings({ affiliateMinRedeemVnd: 50000 });
  assert.throws(
    () => db.transaction(() => wallet.convertToCreditSync(db, "aff", { currency: "VND", amount: 40000 }, { now: at(T0 + DAY) })),
    (error) => error.reason === "below_minimum"
  );
  assert.throws(
    () => db.transaction(() => wallet.convertToCreditSync(db, "aff", { currency: "VND", amount: 999999 }, { now: at(T0 + DAY) })),
    (error) => error.reason === "insufficient"
  );
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM userPlans WHERE userId = 'aff'`).n, 0, "nothing granted");
  assert.equal(db.transaction(() => wallet.walletSync(db, "aff", at(T0 + DAY))).VND.available, 300000, "nothing deducted");
});

test("two concurrent full-balance spends: exactly one succeeds", async () => {
  fundedAffiliate({ balance: 300000 });
  const attempt = () => new Promise((resolve) => {
    setImmediate(() => {
      try {
        resolve(db.transaction(() => vouchers.createVoucherSync(db, "aff", { currency: "VND", amount: 300000 }, { now: at(T0 + DAY) })));
      } catch (error) {
        resolve(error);
      }
    });
  });
  const results = await Promise.all([attempt(), attempt()]);
  assert.equal(results.filter((r) => r?.status === "active").length, 1);
  assert.equal(results.filter((r) => r instanceof wallet.WalletError && r.reason === "insufficient").length, 1);
});

test("a blocked affiliate cannot spend", () => {
  fundedAffiliate();
  db.run(`UPDATE affiliates SET status = 'blocked' WHERE userId = 'aff'`);
  assert.throws(
    () => db.transaction(() => vouchers.createVoucherSync(db, "aff", { currency: "VND", amount: 100000 }, { now: at(T0 + DAY) })),
    (error) => error.reason === "blocked" && error.status === 403
  );
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM affiliateVouchers`).n, 0);
});

test("a voucher is created from the wallet and cancelling it refunds", () => {
  fundedAffiliate();
  const voucher = db.transaction(() => vouchers.createVoucherSync(db, "aff", { currency: "VND", amount: 100000 }, { now: at(T0 + DAY) }));
  assert.match(voucher.code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{12}$/);
  assert.equal(db.transaction(() => wallet.walletSync(db, "aff", at(T0 + DAY))).VND.available, 200000);

  db.transaction(() => vouchers.cancelVoucherSync(db, "aff", voucher.id, { now: at(T0 + DAY + MIN) }));
  const w = db.transaction(() => wallet.walletSync(db, "aff", at(T0 + DAY + MIN)));
  assert.equal(w.VND.available, 300000);
  assert.equal(w.VND.spent, 0, "a cancelled voucher is not spent");
  assert.throws(
    () => db.transaction(() => vouchers.cancelVoucherSync(db, "aff", voucher.id)),
    (error) => error.status === 409
  );
  assert.throws(
    () => db.transaction(() => vouchers.cancelVoucherSync(db, "someone-else", voucher.id)),
    (error) => error.status === 404,
    "only the owner can cancel"
  );
});

// ── Wallet ──────────────────────────────────────────────────────────────────

test("the two currencies are kept apart", () => {
  enableProgram({ affiliateDefaultRateBp: 1000, affiliateDefaultMaxOrders: 10, affiliateHoldDays: 0 });
  makeAffiliate("aff", { maxOrders: 10 });
  plan();
  user("buyer", { referredByUserId: "aff" });

  orderRow({ id: "v1", userId: "buyer", payCurrency: "VND", payAmount: 500000 });
  orderRow({ id: "u1", userId: "buyer", payCurrency: "USDT", payAmount: 20 * NANO, amountNanoUsd: USD(20) });
  approve("v1", T0 + MIN);
  approve("u1", T0 + 2 * MIN);

  const walletNow = db.transaction(() => wallet.walletSync(db, "aff", at(T0 + 3 * MIN)));
  assert.equal(walletNow.VND.available, 50000);
  assert.equal(walletNow.USD.available, 2 * NANO);
  assert.equal(walletNow.VND.earned, 50000);
  assert.equal(walletNow.USD.earned, 2 * NANO);
});

test("an admin adjustment requires a reason and a non-zero integer delta", () => {
  fundedAffiliate();
  assert.throws(
    () => db.transaction(() => wallet.adjustWalletSync(db, "aff", { currency: "VND", delta: 1000, reason: "" }, { actor: "admin:test" })),
    (error) => error.reason === "missing_reason"
  );
  assert.throws(
    () => db.transaction(() => wallet.adjustWalletSync(db, "aff", { currency: "VND", delta: 0, reason: "fix" }, { actor: "admin:test" })),
    (error) => error.reason === "bad_delta"
  );
  const after = db.transaction(() =>
    wallet.adjustWalletSync(db, "aff", { currency: "VND", delta: -1000, reason: "Trừ hoa hồng cộng thừa" }, { actor: "admin:test" })
  );
  assert.equal(after.VND.available, 299000);
});

// ── Welcome gift ────────────────────────────────────────────────────────────

test("eligible referral gift requires a new-user code, active and in window, not exhausted", () => {
  enableProgram();
  const id = newUserGiftCode("g1");
  assert.ok(gift.eligibleReferralGiftSync(db, id), "eligible");

  db.run(`UPDATE giftCodes SET isActive = 0 WHERE id = 'g1'`);
  assert.equal(gift.eligibleReferralGiftSync(db, id), null, "inactive");

  db.run(`UPDATE giftCodes SET isActive = 1, startsAt = ? WHERE id = 'g1'`, [at(T0 + DAY)]);
  assert.equal(gift.eligibleReferralGiftSync(db, id, { now: T0 }), null, "not started");
  assert.ok(gift.eligibleReferralGiftSync(db, id, { now: T0 + 2 * DAY }), "inside the window");

  db.run(`UPDATE giftCodes SET startsAt = NULL, expiresAt = ? WHERE id = 'g1'`, [at(T0 - DAY)]);
  assert.equal(gift.eligibleReferralGiftSync(db, id, { now: T0 }), null, "expired");

  db.run(`UPDATE giftCodes SET expiresAt = NULL, redeemedCount = 100 WHERE id = 'g1'`);
  assert.equal(gift.eligibleReferralGiftSync(db, id), null, "exhausted");

  // A non-new-user code is never eligible, whatever its window says.
  db.run(
    `INSERT INTO giftCodes(id, code, grantKind, creditNanoUsd, durationDays, maxRedemptions, redeemedCount,
                           perUserLimit, isActive, newUserOnly, createdAt, updatedAt)
     VALUES('g2', 'PLAIN2', 'credit', ?, 30, 100, 0, 1, 1, 0, ?, ?)`,
    [USD(5), at(T0), at(T0)]
  );
  assert.equal(gift.eligibleReferralGiftSync(db, "g2"), null);
});

test("the effective gift id is the override, else the default", () => {
  enableProgram();
  const id = newUserGiftCode("g1");
  db.run(
    `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
    [JSON.stringify({ affiliateEnabled: true, affiliateDefaultGiftCodeId: id })]
  );
  const row = makeAffiliate("aff");
  const merged = settingsLib.readAffiliateSettingsSync(db);
  assert.equal(affiliate.effectiveTermsSync(row, merged).giftCodeId, "g1");

  db.run(`UPDATE affiliates SET giftCodeId = 'other' WHERE userId = 'aff'`);
  const overridden = db.get(`SELECT * FROM affiliates WHERE userId = 'aff'`);
  assert.equal(affiliate.effectiveTermsSync(overridden, merged).giftCodeId, "other");
});

test("a referred account sees its gift until it redeems it", () => {
  enableProgram();
  const id = newUserGiftCode("g1");
  db.run(
    `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
    [JSON.stringify({ affiliateEnabled: true, affiliateDefaultGiftCodeId: id })]
  );
  makeAffiliate("aff");
  user("buyer", { referredByUserId: "aff" });

  const settings = settingsLib.readAffiliateSettingsSync(db);
  const offered = gift.referralGiftForBuyerSync(db, "buyer", { settings });
  assert.ok(offered, "offered before redemption");
  assert.equal(offered.id, "g1");

  db.run(`INSERT INTO giftRedemptions(id, giftId, userId, redeemedAt) VALUES('r1', 'g1', 'buyer', ?)`, [at(T0)]);
  assert.equal(gift.referralGiftForBuyerSync(db, "buyer", { settings }), null, "spent");
});

test("redeeming a new-user code through the referral still needs Telegram", () => {
  enableProgram();
  const id = newUserGiftCode("g1");
  plan();
  user("buyer", { referredByUserId: "aff" });
  makeAffiliate("aff");

  const result = db.transaction(() => giftRepo.redeemGiftCode(db, { userId: "buyer", code: "WELC-OME1" }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "telegram_required", "the existing new-user rule is unchanged");
  assert.equal(id, "g1");
});

// ── Settings reader and validation ──────────────────────────────────────────

test("the sync reader returns exactly what updateSettings stored", async () => {
  await settingsRepo.updateSettings({
    affiliateEnabled: true,
    affiliateDefaultRateBp: 1750,
    affiliateDefaultMaxOrders: 0,
    affiliateHoldDays: 3,
    affiliateCookieDays: 14,
    affiliateMinRedeemVnd: 250000,
    affiliateMinRedeemUsdNano: 2 * NANO,
    affiliateVndPerUsd: 26000,
    affiliateDefaultGiftCodeId: "g1",
  });

  const sync = settingsLib.readAffiliateSettingsSync(db);
  const async = await settingsRepo.getSettings();

  assert.equal(sync.affiliateEnabled, true);
  assert.equal(sync.affiliateDefaultRateBp, 1750);
  assert.equal(sync.affiliateDefaultMaxOrders, 0);
  assert.equal(sync.affiliateHoldDays, 3);
  assert.equal(sync.affiliateCookieDays, 14);
  assert.equal(sync.affiliateMinRedeemVnd, 250000);
  assert.equal(sync.affiliateMinRedeemUsdNano, 2 * NANO);
  assert.equal(sync.affiliateVndPerUsd, 26000);
  assert.equal(sync.affiliateDefaultGiftCodeId, "g1");

  for (const key of settingsLib.AFFILIATE_SETTING_KEYS) {
    assert.deepEqual(sync[key], async[key], `${key} must match between the two readers`);
  }
});

test("the sync reader merges the defaults when nothing is stored", () => {
  const sync = settingsLib.readAffiliateSettingsSync(db);
  assert.equal(sync.affiliateEnabled, false, "off by default");
  assert.equal(sync.affiliateDefaultRateBp, 1000);
  assert.equal(sync.affiliateDefaultMaxOrders, 1);
  assert.equal(sync.affiliateHoldDays, 7);
  assert.equal(sync.affiliateCookieDays, 30);
  assert.equal(sync.affiliateMinRedeemVnd, 10000);
  assert.equal(sync.affiliateMinRedeemUsdNano, 1 * NANO);
  assert.equal(sync.affiliateVndPerUsd, 25000);
  assert.equal(sync.affiliateCreditPlanId, "");
  assert.equal(sync.affiliateCreditDays, 30);
  assert.equal(sync.affiliateBuyerBonusBp, 0);
  assert.equal(sync.affiliateBuyerBonusMaxOrders, 1);
  assert.equal(sync.affiliateDefaultGiftCodeId, "");
});

test("an out-of-range rate is rejected and the stored value is unchanged", async () => {
  await settingsRepo.updateSettings({ affiliateDefaultRateBp: 1500 });
  const invalid = settingsLib.validateAffiliateSettings({ affiliateDefaultRateBp: 12000 });
  assert.ok(invalid.error, "12000 bp is out of range");

  // Nothing was written: the validator never touches the database.
  assert.equal((await settingsRepo.getSettings()).affiliateDefaultRateBp, 1500);

  assert.ok(settingsLib.validateAffiliateSettings({ affiliateHoldDays: 0 }).error === undefined);
  assert.ok(settingsLib.validateAffiliateSettings({ affiliateHoldDays: 366 }).error);
  assert.ok(settingsLib.validateAffiliateSettings({ affiliateCookieDays: 0 }).error);
  assert.ok(settingsLib.validateAffiliateSettings({ affiliateDefaultMaxOrders: 1001 }).error);
  assert.ok(settingsLib.validateAffiliateSettings({ affiliateEnabled: "yes" }).error);
  assert.ok(settingsLib.validateAffiliateSettings({ affiliateMinRedeemVnd: -1 }).error);
  assert.ok(settingsLib.validateAffiliateSettings({ affiliateVndPerUsd: 0 }).error);
  assert.ok(settingsLib.validateAffiliateSettings({ affiliateCreditDays: 0 }).error);
  assert.ok(settingsLib.validateAffiliateSettings({ affiliateBuyerBonusBp: 10001 }).error);
  assert.equal(settingsLib.validateAffiliateSettings({ affiliateDefaultRateBp: "1200" }).value.affiliateDefaultRateBp, 1200);
});

test("override validation uses the defaults' bounds and accepts null to clear", () => {
  assert.equal(settingsLib.validateOverride("rateBp", null).value, null);
  assert.equal(settingsLib.validateOverride("rateBp", "").value, null);
  assert.equal(settingsLib.validateOverride("rateBp", 2500).value, 2500);
  assert.ok(settingsLib.validateOverride("rateBp", 10001).error);
  assert.equal(settingsLib.validateOverride("maxOrders", 0).value, 0);
  assert.ok(settingsLib.validateOverride("maxOrders", -1).error);
});

// ── Masking ─────────────────────────────────────────────────────────────────

test("maskEmail keeps two characters of the local part", () => {
  assert.equal(mask.maskEmail("nguyen@example.com"), "ng***@example.com");
  assert.equal(mask.maskEmail(" a@gmail.com "), "a***@gmail.com");
  assert.equal(mask.maskEmail(""), "");
  assert.equal(mask.maskEmail("not-an-address"), "***");
  assert.equal(mask.maskEmail("@nope.com"), "***");
  assert.equal(mask.maskTail("0123456789"), "***6789");
  assert.equal(mask.maskTail("0123456789", 6), "***456789");
});

// ── Review fixes ────────────────────────────────────────────────────────────

test("spending is refused while the program is off, and nothing is deducted", () => {
  fundedAffiliate();
  saveSettings({ affiliateEnabled: false });
  assert.throws(
    () => db.transaction(() =>
      vouchers.createVoucherSync(db, "aff", { currency: "VND", amount: 200000 }, { now: at(T0 + DAY) })
    ),
    (error) => error.reason === "program_disabled" && error.status === 403
  );
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM affiliateVouchers`)?.n, 0);
});

test("settings validation refuses dotted thousands, blanks and booleans", () => {
  const v = settingsLib.validateAffiliateSettings;
  assert.ok(v({ affiliateMinRedeemVnd: "100.000" }).error, "100.000 must not become 100");
  assert.ok(v({ affiliateDefaultMaxOrders: "" }).error, "blank must not become 0");
  assert.ok(v({ affiliateHoldDays: "   " }).error);
  assert.ok(v({ affiliateHoldDays: true }).error, "Number(true) is 1");
  assert.equal(v({ affiliateMinRedeemVnd: "100000" }).value.affiliateMinRedeemVnd, 100000);
  assert.equal(v({ affiliateHoldDays: 7 }).value.affiliateHoldDays, 7);
  assert.ok(settingsLib.validateOverride("maxOrders", "5.0").error);
  assert.equal(settingsLib.validateOverride("maxOrders", "5").value, 5);
});

test("money inputs parse exactly what the customer typed", async () => {
  const amounts = await import("../src/lib/affiliate/amountInput.js");
  assert.equal(amounts.parseVndInput("100000"), 100000);
  assert.equal(amounts.parseVndInput("100.000"), 100000);
  assert.equal(amounts.parseVndInput("1,250,000"), 1250000);
  assert.equal(amounts.parseVndInput("100 000"), 100000);
  assert.equal(amounts.parseVndInput("150000.5"), null, "no decimals in đồng");
  assert.equal(amounts.parseVndInput("10.00"), null);
  assert.equal(amounts.parseVndInput("-5"), null);
  assert.equal(amounts.parseVndInput(""), null);

  assert.equal(amounts.parseUsdInput("10"), 10 * NANO);
  assert.equal(amounts.parseUsdInput("12.50"), 12_500_000_000);
  assert.equal(amounts.parseUsdInput("$12.35"), 12_350_000_000);
  assert.equal(amounts.parseUsdInput("12,5"), 12_500_000_000);
  assert.equal(amounts.parseUsdInput("0.1"), 100_000_000);
  assert.equal(amounts.parseUsdInput("1e3"), null);
  assert.equal(amounts.parseUsdInput("abc"), null);

  assert.equal(amounts.parseSignedAmountInput("VND", "-50.000"), -50000);
  assert.equal(amounts.parseSignedAmountInput("USD", "-1.5"), -1_500_000_000);
  assert.equal(amounts.parseSignedAmountInput("USD", "0"), null);
  assert.equal(amounts.parseCountInput("7"), 7);
  assert.equal(amounts.parseCountInput(""), null);
  assert.equal(amounts.parseCountInput("1.5"), null);
});

test("an admin cancel cannot overwrite an order paid in the meantime", async () => {
  enableProgram({ affiliateHoldDays: 0 });
  makeAffiliate("aff");
  plan();
  user("buyer", { referredByUserId: "aff" });
  orderRow({ id: "o1", userId: "buyer" });
  // The route read "pending"; the gateway approves before the cancel is written.
  approve("o1");
  const result = await billingRepo.updateOrderStatus("o1", { status: "cancelled", fromStatus: "pending" });
  assert.equal(result.changed, false);
  assert.equal(db.get(`SELECT status FROM orders WHERE id = 'o1'`).status, "paid");
  assert.equal(commissions("o1").length, 1, "the commission still matches a refundable order");
});

test("the welcome gift is not advertised while the program is off or the referrer is blocked", () => {
  enableProgram();
  makeAffiliate("aff");
  user("buyer", { referredByUserId: "aff" });
  newUserGiftCode("g1");
  saveSettings({ affiliateDefaultGiftCodeId: "g1" });
  const read = () => gift.referralGiftForBuyerSync(db, "buyer", { settings: settingsLib.readAffiliateSettingsSync(db) });
  assert.ok(read(), "advertised while on and active");

  db.run(`UPDATE affiliates SET status = 'blocked' WHERE userId = 'aff'`);
  assert.equal(read(), null, "blocked referrer");
  db.run(`UPDATE affiliates SET status = 'active' WHERE userId = 'aff'`);
  saveSettings({ affiliateEnabled: false });
  assert.equal(read(), null, "program off");
});

test("spend amounts and admin deltas accept whole numbers only, from any caller", () => {
  fundedAffiliate();
  for (const amount of ["100.000", "1e5", "0x10", true]) {
    assert.throws(
      () => db.transaction(() => vouchers.createVoucherSync(db, "aff", { currency: "VND", amount }, { now: at(T0 + DAY) })),
      (error) => error.reason === "bad_amount",
      String(amount)
    );
  }
  for (const delta of ["1e3", "100.000", true, "-0"]) {
    assert.throws(
      () => db.transaction(() => wallet.adjustWalletSync(db, "aff", { currency: "VND", delta, reason: "test adj" })),
      (error) => error.reason === "bad_delta",
      String(delta)
    );
  }
  const after = db.transaction(() => wallet.adjustWalletSync(db, "aff", { currency: "VND", delta: "-5000", reason: "test adj" }));
  assert.equal(after.VND.available, 300000 - 5000);
});

// ── Admin commission actions (spec "Admin commission actions") ───────────────

test("admin early release makes a held commission available now, exactly once", () => {
  enableProgram({ affiliateHoldDays: 7 });
  makeAffiliate("aff");
  plan();
  user("buyer", { referredByUserId: "aff" });
  orderRow({ id: "o1", userId: "buyer" });
  approve("o1", T0);
  const row = commissions("o1")[0];
  assert.equal(row.status, "pending");

  const first = db.transaction(() =>
    commission.releaseCommissionNowSync(db, row.id, { actor: "admin:a", now: at(T0 + DAY) })
  );
  assert.equal(first.released, true);
  assert.equal(first.row.status, "available");
  assert.equal(first.row.releasedAt, at(T0 + DAY));
  assert.equal(ledger("aff").length, 1);
  const w = db.transaction(() => wallet.walletSync(db, "aff", at(T0 + DAY)));
  assert.equal(w.VND.available, 25000, "available before the hold would have ended");

  // A second release, and the later automatic release, change nothing.
  const again = db.transaction(() => commission.releaseCommissionNowSync(db, row.id, { now: at(T0 + 2 * DAY) }));
  assert.equal(again.released, false);
  db.transaction(() => commission.releaseDueSync(db, "aff", at(T0 + 8 * DAY)));
  assert.equal(ledger("aff").length, 1);

  const audit = db.get(`SELECT * FROM userAuditLog WHERE userId = 'aff' AND action = 'affiliate_commission_released'`);
  assert.ok(audit, "early release is audited on the affiliate");
  assert.equal(audit.actor, "admin:a");
});

test("admin cancel needs a reason and claws back an available commission", () => {
  enableProgram({ affiliateHoldDays: 0 });
  makeAffiliate("aff");
  plan();
  user("buyer", { referredByUserId: "aff" });
  orderRow({ id: "o1", userId: "buyer" });
  approve("o1", T0);
  db.transaction(() => wallet.walletSync(db, "aff", at(T0 + MIN)));
  const row = commissions("o1")[0];
  assert.equal(row.status, "available");

  assert.throws(
    () => db.transaction(() => commission.reverseCommissionByIdSync(db, row.id, { reason: "  " })),
    /reason/i
  );
  assert.equal(commissions("o1")[0].status, "available", "a refused cancel changes nothing");

  const res = db.transaction(() =>
    commission.reverseCommissionByIdSync(db, row.id, { actor: "admin:a", reason: "fraud", now: at(T0 + DAY) })
  );
  assert.equal(res.reversed, true);
  assert.equal(commissions("o1")[0].status, "reversed");
  const w = db.transaction(() => wallet.walletSync(db, "aff", at(T0 + DAY)));
  assert.equal(w.VND.available, 0, "the reversal row cancels the commission row");
  assert.equal(ledger("aff").filter((l) => l.kind === "reversal").length, 1);
  const audit = db.get(`SELECT * FROM userAuditLog WHERE userId = 'aff' AND action = 'affiliate_commission_reversed'`);
  assert.equal(audit.reason, "fraud");

  // Cancelled cannot be released or cancelled again.
  assert.equal(db.transaction(() => commission.releaseCommissionNowSync(db, row.id)).released, false);
  assert.equal(
    db.transaction(() => commission.reverseCommissionByIdSync(db, row.id, { reason: "again" })).reversed,
    false
  );
  assert.equal(ledger("aff").filter((l) => l.kind === "reversal").length, 1);
});

test("admin actions through the repo report the status they cannot apply to", async () => {
  enableProgram({ affiliateHoldDays: 7 });
  makeAffiliate("aff");
  plan();
  user("buyer", { referredByUserId: "aff" });
  orderRow({ id: "o1", userId: "buyer" });
  approve("o1", T0);
  const id = commissions("o1")[0].id;

  assert.deepEqual(await affiliateRepo.actOnCommission("nope", "release"), { error: "not_found" });
  assert.deepEqual(await affiliateRepo.actOnCommission(id, "frobnicate"), { error: "bad_action" });
  const cancelled = await affiliateRepo.actOnCommission(id, "reverse", { reason: "test" });
  assert.equal(cancelled.commission.status, "reversed");
  assert.deepEqual(await affiliateRepo.actOnCommission(id, "release"), { error: "not_pending" });
  assert.deepEqual(await affiliateRepo.actOnCommission(id, "reverse", { reason: "x" }), { error: "already_reversed" });
});

test("admin referral list shows each referred account with its referrer and commission", async () => {
  enableProgram({ affiliateHoldDays: 7 });
  makeAffiliate("aff", { code: "AFFONE" });
  makeAffiliate("aff2", { code: "AFFTWO" });
  plan();
  user("buyer", { referredByUserId: "aff", email: "buyer@x.com" });
  user("lurker", { referredByUserId: "aff2", email: "lurker@x.com" });
  user("organic", { email: "organic@x.com" });
  orderRow({ id: "o1", userId: "buyer" });
  approve("o1", T0);

  const all = await affiliateRepo.listReferrals({});
  assert.equal(all.total, 2, "only accounts with a referrer are listed");
  const buyer = all.rows.find((r) => r.userId === "buyer");
  assert.equal(buyer.affiliateUserId, "aff");
  assert.equal(buyer.affiliateCode, "AFFONE");
  assert.equal(buyer.paidOrders, 1);
  assert.deepEqual(
    buyer.commissions.map((c) => [c.currency, c.status, c.amount]),
    [["VND", "pending", 25000]]
  );
  assert.deepEqual(all.rows.find((r) => r.userId === "lurker").commissions, []);

  const filtered = await affiliateRepo.listReferrals({ affiliateUserId: "aff2" });
  assert.deepEqual(filtered.rows.map((r) => r.userId), ["lurker"]);
  const searched = await affiliateRepo.listReferrals({ q: "afftwo" });
  assert.deepEqual(searched.rows.map((r) => r.userId), ["lurker"], "search matches the referrer's code");
});

test("early release refuses a deleted affiliate and moves availableAt to now", async () => {
  enableProgram({ affiliateHoldDays: 7 });
  makeAffiliate("aff");
  makeAffiliate("gone");
  plan();
  user("buyer", { referredByUserId: "aff" });
  user("buyer2", { referredByUserId: "gone" });
  orderRow({ id: "o1", userId: "buyer" });
  orderRow({ id: "o2", userId: "buyer2" });
  approve("o1", T0);
  approve("o2", T0);

  const kept = commissions("o1")[0];
  db.transaction(() => commission.releaseCommissionNowSync(db, kept.id, { now: at(T0 + DAY) }));
  assert.equal(commissions("o1")[0].availableAt, at(T0 + DAY), "available from the release, not the old hold end");

  db.run(`DELETE FROM users WHERE id = 'gone'`);
  const orphan = commissions("o2")[0];
  assert.deepEqual(await affiliateRepo.actOnCommission(orphan.id, "release"), { error: "affiliate_deleted" });
  assert.equal(db.transaction(() => commission.releaseCommissionNowSync(db, orphan.id)).released, false);
  assert.equal(commissions("o2")[0].status, "pending");
  assert.equal(ledger("gone").length, 0, "no wallet entry for a deleted account");
});

test("referral list counts only the current referrer's commission and escapes LIKE", async () => {
  enableProgram({ affiliateHoldDays: 7 });
  makeAffiliate("aff", { code: "AFFONE" });
  makeAffiliate("aff2", { code: "AFFTWO" });
  plan();
  user("buyer", { referredByUserId: "aff", email: "buyer_1@x.com" });
  user("other", { referredByUserId: "aff", email: "buyerx1@x.com" });
  orderRow({ id: "o1", userId: "buyer" });
  approve("o1", T0);
  await affiliateRepo.setUserReferrer("buyer", "aff2", { actor: "admin", reason: "moved" });

  const row = (await affiliateRepo.listReferrals({ affiliateUserId: "aff2" })).rows[0];
  assert.equal(row.userId, "buyer");
  assert.deepEqual(row.commissions, [], "aff's commission is not shown under aff2");

  const hit = await affiliateRepo.listReferrals({ q: "buyer_1" });
  assert.deepEqual(hit.rows.map((r) => r.userId), ["buyer"], "_ is a literal character, not a wildcard");
});

// ── Invite-only access (change affiliate-landing-admin) ──────────────────────

test("access mode is validated and defaults to open", () => {
  assert.equal(settingsLib.AFFILIATE_SETTING_DEFAULTS.affiliateAccess, "open");
  assert.deepEqual(settingsLib.validateAffiliateSettings({ affiliateAccess: "invite" }).value, { affiliateAccess: "invite" });
  assert.ok(settingsLib.validateAffiliateSettings({ affiliateAccess: "everyone" }).error);
  assert.ok(settingsLib.validateAffiliateSettings({ affiliateAccess: true }).error);
});

test("invite-only: an uninvited link stops recording new users, an invited one keeps working", () => {
  enableProgram();
  makeAffiliate("plain", { code: "PLAIN1" });
  makeAffiliate("vip", { code: "VIPVIP" });
  db.run(`UPDATE affiliates SET invitedAt = ? WHERE userId = 'vip'`, [at(T0)]);

  assert.equal(affiliate.resolveReferrerSync(db, "PLAIN1"), "plain", "open mode: every link works");
  saveSettings({ affiliateAccess: "invite" });
  assert.equal(affiliate.resolveReferrerSync(db, "PLAIN1"), null, "uninvited link refused");
  assert.equal(affiliate.resolveReferrerSync(db, "VIPVIP"), "vip", "invited link works");
  assert.deepEqual(
    affiliate.resolveFirstReferralSync(db, ["PLAIN1", "VIPVIP"]),
    { code: "VIPVIP", referrerId: "vip" },
    "the register page falls through to the next valid code"
  );

  db.run(`UPDATE affiliates SET status = 'blocked' WHERE userId = 'vip'`);
  assert.equal(affiliate.resolveReferrerSync(db, "VIPVIP"), null, "blocking still wins");
});

test("invite-only: an uninvited affiliate keeps earning from users it already referred", () => {
  enableProgram({ affiliateDefaultMaxOrders: 0 });
  makeAffiliate("aff");
  plan();
  user("buyer", { referredByUserId: "aff" });
  saveSettings({ affiliateAccess: "invite" });

  orderRow({ id: "o1" });
  approve("o1");
  const rows = commissions("o1");
  assert.equal(rows.length, 1, "existing referral still accrues");
  assert.equal(rows[0].affiliateUserId, "aff");
});

test("invite-only: the customer area hides the page unless invited or something to keep", () => {
  enableProgram();
  user("newbie");
  makeAffiliate("referrer");
  user("child", { referredByUserId: "referrer" });
  makeAffiliate("vip");
  db.run(`UPDATE affiliates SET invitedAt = ? WHERE userId = 'vip'`, [at(T0)]);

  assert.equal(affiliate.affiliateAreaAvailableSync(db, "newbie"), true, "open mode: everyone");
  saveSettings({ affiliateAccess: "invite" });
  assert.equal(affiliate.affiliateAreaAvailableSync(db, "newbie"), false, "uninvited, nothing to keep");
  assert.equal(affiliate.affiliateAreaAvailableSync(db, "referrer"), true, "has referred users");
  assert.equal(affiliate.affiliateAreaAvailableSync(db, "vip"), true, "invited");
  saveSettings({ affiliateEnabled: false });
  assert.equal(affiliate.affiliateAreaAvailableSync(db, "vip"), false, "program off, no history");
});

test("invite-only: opening the page creates no code for an uninvited account", async () => {
  enableProgram({ affiliateAccess: "invite" });
  user("newbie");
  const overview = await affiliateRepo.getAffiliateOverview("newbie");
  assert.equal(overview.canRefer, false);
  assert.equal(overview.code, null);
  assert.equal(overview.available, false);
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM affiliates WHERE userId = 'newbie'`).n, 0, "no row created");

  saveSettings({ affiliateAccess: "open" });
  const open = await affiliateRepo.getAffiliateOverview("newbie");
  assert.equal(open.canRefer, true);
  assert.ok(open.code, "open mode creates the code on first visit");
});

test("invite-only: an uninvited affiliate can still spend its wallet", () => {
  fundedAffiliate();
  saveSettings({ affiliateAccess: "invite" });
  const voucher = db.transaction(() => vouchers.createVoucherSync(db, "aff", { currency: "VND", amount: 100000 }, { now: at(T0 + DAY) }));
  assert.equal(voucher.status, "active");
});

test("admin invite by email or id creates the code once and is audited", async () => {
  enableProgram({ affiliateAccess: "invite" });
  user("cand", { email: "Cand@Test.Local" });

  assert.deepEqual(await affiliateRepo.inviteAffiliate("nobody@test.local"), { error: "user_not_found" });

  const first = await affiliateRepo.inviteAffiliate("cand@test.local", { actor: "admin:t", reason: "VIP" });
  assert.equal(first.alreadyInvited, false);
  assert.equal(first.user.id, "cand");
  assert.ok(first.affiliate.code);
  assert.ok(first.affiliate.invitedAt);
  assert.equal(affiliate.resolveReferrerSync(db, first.affiliate.code), "cand");

  const again = await affiliateRepo.inviteAffiliate("cand");
  assert.equal(again.alreadyInvited, true);
  assert.equal(again.affiliate.code, first.affiliate.code, "same code");
  const audits = db.all(`SELECT action, actor FROM userAuditLog WHERE userId = 'cand' AND action = 'affiliate_invited'`);
  assert.deepEqual(audits, [{ action: "affiliate_invited", actor: "admin:t" }], "audited once");
});

test("admin can withdraw and restore an invitation; the list filters by it", async () => {
  enableProgram({ affiliateAccess: "invite" });
  makeAffiliate("a1", { code: "AAAAA1" });
  makeAffiliate("a2", { code: "AAAAA2" });
  await affiliateRepo.inviteAffiliate("a1");
  const invitedAt = db.get(`SELECT invitedAt FROM affiliates WHERE userId = 'a1'`).invitedAt;

  const invitedOnly = await affiliateRepo.listAffiliates({ invited: "yes" });
  assert.deepEqual(invitedOnly.rows.map((r) => r.userId), ["a1"]);
  const notInvited = await affiliateRepo.listAffiliates({ invited: "no" });
  assert.deepEqual(notInvited.rows.map((r) => r.userId), ["a2"]);

  await affiliateRepo.updateAffiliate("a1", { invited: true });
  assert.equal(db.get(`SELECT invitedAt FROM affiliates WHERE userId = 'a1'`).invitedAt, invitedAt, "re-inviting keeps the date");

  await affiliateRepo.updateAffiliate("a1", { invited: false });
  assert.equal(db.get(`SELECT invitedAt FROM affiliates WHERE userId = 'a1'`).invitedAt, null);
  assert.equal(affiliate.resolveReferrerSync(db, "AAAAA1"), null, "withdrawn invitation stops the link");

  await affiliateRepo.updateAffiliate("a2", { invited: true });
  assert.equal(affiliate.resolveReferrerSync(db, "AAAAA2"), "a2");
});

test("invite-only: a buyer referred earlier keeps the buyer bonus", async () => {
  enableProgram({ affiliateBuyerBonusBp: 1000, affiliateBuyerBonusMaxOrders: 2 });
  makeAffiliate("aff");
  user("buyer", { referredByUserId: "aff" });
  saveSettings({ affiliateAccess: "invite" });
  const { buyerBonusTermsSync } = await import("../src/lib/affiliate/buyerBonus.js");
  const terms = buyerBonusTermsSync(db, "buyer");
  assert.equal(terms?.bp, 1000, "the earlier referral still gets its bonus");
  assert.equal(affiliate.resolveReferrerSync(db, db.get(`SELECT code FROM affiliates WHERE userId = 'aff'`).code), null, "but the link records nobody new");
});
