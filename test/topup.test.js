// Custom-amount top-up (spec payment-checkout "Custom-amount top-up").
//
// A plan with `allowCustomAmount` sells credit at its own rate: the Start plan
// prices 10.000đ for $10 of credit, so 50.000đ buys $50. These cases pin the
// arithmetic (integer, floor on credit, ceil-to-cent on the USD price), the bounds,
// that the order snapshots what was typed, and that approving it grants exactly
// that credit.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-topup-test-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const billing = await import("../src/lib/db/repos/billingRepo.js");
const checkout = await import("../src/lib/payments/checkout.js");
const { approveOrderSync } = await import("../src/lib/billing/orders.js");
const reconcile = await import("../src/lib/payments/reconcile.js");
const { quoteTopup, topupEnabled, topupBounds, TOPUP_DEFAULT_MAX_VND } = await import("../src/lib/billing/topup.js");
const { NANO } = await import("../src/shared/utils/money.js");

let db;
const USD = (n) => Math.round(n * NANO);
const T0 = Date.UTC(2026, 9, 29, 10, 0, 0);
const at = (ms) => new Date(ms).toISOString();
const SETTINGS = { paymentCodePrefix: "DR", paymentOrderTtlMinutes: 30, allowManualOrders: true };

before(async () => { db = await getAdapter(); });

after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  for (const table of ["paymentTransactions", "paymentProviders", "creditLedger", "userPlans", "orders", "plans", "users", "kv"]) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* partial schema */ }
  }
});

function user(id = "u1") {
  db.run(
    `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
     VALUES(?, ?, 'x', NULL, NULL, 'active', 0, ?, ?)`,
    [id, `${id}@test.local`, at(T0), at(T0)]
  );
  return id;
}

function providers() {
  for (const [id, kind] of [["v1", "sepay"], ["b1", "binance"]]) {
    db.run(
      `INSERT INTO paymentProviders(id, kind, name, isActive, sortOrder, config, secrets, pollIntervalSeconds, createdAt, updatedAt)
       VALUES(?, ?, ?, 1, 0, ?, '{}', 30, ?, ?)`,
      [id, kind, kind, JSON.stringify({ accountNumber: "1017588888", bankBin: "970436", bankName: "Vietcombank" }), at(T0), at(T0)]
    );
  }
}

// The Start plan of the owner's shop: 10.000đ ($0.40 in USDT) buys $10 of credit.
const START = {
  code: "start", name: "Start", priceNanoUsd: USD(0.4), priceVnd: 10000, creditNanoUsd: USD(10),
  durationDays: 30, allowCustomAmount: true,
};

const startPlan = async (overrides = {}) => billing.getPlanById((await billing.createPlan({ ...START, ...overrides })).id);

test("1. quote: 50.000đ at 10.000đ = $10 is $50 of credit for $2", () => {
  const plan = { ...START, customMinVnd: null, customMaxVnd: null };
  const quote = quoteTopup(plan, 50000);
  assert.deepEqual(quote, { ok: true, amountVnd: 50000, creditNanoUsd: USD(50), priceNanoUsd: USD(2) });
});

test("2. quote: credit rounds down, the USD price rounds up to a cent", () => {
  const quote = quoteTopup(START, 12345);
  assert.equal(quote.ok, true);
  assert.equal(quote.creditNanoUsd, USD(12.345));
  assert.equal(quote.priceNanoUsd, USD(0.5), "$0.4938 is charged as $0.50, never less");

  const odd = quoteTopup({ ...START, priceVnd: 3, creditNanoUsd: USD(1) }, 10);
  assert.equal(odd.creditNanoUsd, Math.floor((10 * USD(1)) / 3), "integer floor, no float drift");
});

test("3. quote: large amounts stay exact (no 2^53 overflow)", () => {
  const plan = { ...START, priceVnd: 250000, creditNanoUsd: USD(400), priceNanoUsd: USD(10), customMaxVnd: 100_000_000 };
  const quote = quoteTopup(plan, 50_000_000);
  assert.equal(quote.creditNanoUsd, USD(80000));
  assert.equal(quote.priceNanoUsd, USD(2000));
});

test("4. quote: bounds and malformed amounts are refused", () => {
  assert.equal(topupBounds(START).minVnd, 10000, "the minimum defaults to the plan price");
  assert.equal(topupBounds(START).maxVnd, TOPUP_DEFAULT_MAX_VND);
  assert.match(quoteTopup(START, 9999).error, /tối thiểu/);
  assert.match(quoteTopup(START, TOPUP_DEFAULT_MAX_VND + 1).error, /tối đa/);
  for (const bad of [0, -5000, 12.5, "abc", "", null, "12.5", [50000], ["5e4"], true, {}, "1e5", "0x10"]) {
    assert.equal(quoteTopup(START, bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(quoteTopup({ ...START, customMinVnd: 2000 }, 2000).ok, true, "an explicit minimum overrides the price");
  assert.equal(quoteTopup(START, "50000").ok, true, "a digit string from the form is accepted");
});

test("4b. an extreme maximum cannot push a quote past the safe-integer range", () => {
  const plan = { ...START, customMaxVnd: 1e15 };
  const quote = quoteTopup(plan, 1e15);
  assert.equal(quote.ok, false);
  assert.match(quote.error, /quá lớn/);
  assert.match(billing.validatePlanInput({ ...START, customMaxVnd: 2e9 }) || "", /không được vượt quá/);
});

test("5. topupEnabled needs the flag, both halves of the rate and a finite plan", () => {
  assert.equal(topupEnabled(START), true);
  assert.equal(topupEnabled({ ...START, allowCustomAmount: false }), false);
  assert.equal(topupEnabled({ ...START, unlimitedCredit: true }), false);
  assert.equal(topupEnabled({ ...START, priceVnd: 0 }), false);
  assert.equal(topupEnabled({ ...START, creditNanoUsd: 0 }), false);
  assert.equal(quoteTopup({ ...START, allowCustomAmount: false }, 50000).ok, false);
});

test("6. validatePlanInput: a top-up plan needs a VND price, not unlimited, min <= max", () => {
  const base = { ...START };
  assert.equal(billing.validatePlanInput(base), null);
  assert.match(billing.validatePlanInput({ ...base, priceVnd: null }) || "", /giá VND/);
  assert.match(
    billing.validatePlanInput({ ...base, unlimitedCredit: true, creditNanoUsd: 0, rpm: 60 }) || "",
    /không giới hạn/
  );
  assert.match(billing.validatePlanInput({ ...base, customMinVnd: 90000, customMaxVnd: 50000 }) || "", /tối thiểu/);
  assert.match(billing.validatePlanInput({ ...base, customMinVnd: -1 }) || "", /tối thiểu/);
  // The default minimum is the price: a maximum below it is contradictory too.
  assert.match(billing.validatePlanInput({ ...base, customMaxVnd: 5000 }) || "", /tối thiểu/);
});

test("7. createPlan/updatePlan store the bounds and drop them when switched off", async () => {
  const created = await billing.createPlan({ ...START, customMinVnd: 5000, customMaxVnd: 2_000_000 });
  assert.equal(created.allowCustomAmount, true);
  assert.equal(created.customMinVnd, 5000);
  assert.equal(created.customMaxVnd, 2_000_000);

  const off = await billing.updatePlan(created.id, { allowCustomAmount: false });
  assert.equal(off.allowCustomAmount, false);
  assert.equal(off.customMinVnd, null, "a switched-off plan keeps no stale bounds");
  assert.equal(off.customMaxVnd, null);
});

test("8. a VietQR top-up order snapshots the typed amount, the credit and the code; approving grants that credit", async () => {
  const u = user(); providers();
  const plan = await startPlan();

  const result = db.transaction(() => checkout.createGatewayOrderSync(db, {
    userId: u, plan, method: "vietqr", settings: SETTINGS, nowIso: at(T0), amountVnd: 50000,
  }));
  assert.equal(result.ok, true);
  const order = result.order;
  assert.equal(order.payCurrency, "VND");
  assert.equal(order.payAmount, 50000, "the customer transfers exactly what they typed");
  assert.equal(order.creditNanoUsd, USD(50));
  assert.equal(order.amountNanoUsd, USD(2));

  // Changing the plan afterwards must not change what this order grants.
  await billing.updatePlan(plan.id, { creditNanoUsd: USD(1) });
  const approved = db.transaction(() => approveOrderSync(db, order.id, { approvedBy: "reconciler", now: at(T0 + 60_000) }));
  assert.equal(approved.userPlan.creditTotalNanoUsd, USD(50));
  assert.equal(approved.userPlan.creditRemainingNanoUsd, USD(50));
  assert.equal(
    new Date(approved.userPlan.expiresAt).getTime() - new Date(approved.userPlan.startsAt).getTime(),
    30 * 24 * 3600 * 1000,
    "the top-up expires like the plan: after durationDays"
  );
});

test("9. a Binance top-up is paid in the USD price of the typed amount", () => {
  const u = user(); providers();
  return startPlan().then((plan) => {
    const result = db.transaction(() => checkout.createGatewayOrderSync(db, {
      userId: u, plan, method: "binance", settings: SETTINGS, nowIso: at(T0), amountVnd: 12345,
    }));
    assert.equal(result.ok, true);
    assert.equal(result.order.payCurrency, "USDT");
    assert.equal(result.order.payAmount, USD(0.5), "rounded up to a cent");
    assert.equal(result.order.creditNanoUsd, USD(12.345));
  });
});

test("10. a bad amount writes no order; a plan without top-up refuses an amount; no amount keeps the fixed price", async () => {
  const u = user(); providers();
  const plan = await startPlan();
  const make = (p, amountVnd) => db.transaction(() => checkout.createGatewayOrderSync(db, {
    userId: u, plan: p, method: "vietqr", settings: SETTINGS, nowIso: at(T0), amountVnd,
  }));

  for (const bad of [100, 99_999_999_999, "1e5", 12.5]) {
    const refused = make(plan, bad);
    assert.equal(refused.ok, false, `${bad}`);
    assert.equal(refused.code, "bad_amount");
    assert.equal(refused.status, 400);
  }
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM orders`).n, 0, "nothing was written");

  const fixed = await billing.getPlanById((await billing.createPlan({ ...START, code: "fixed", allowCustomAmount: false })).id);
  assert.equal(make(fixed, 50000).ok, false, "a plan without top-up takes no amount");

  const plain = make(plan, null);
  assert.equal(plain.ok, true);
  assert.equal(plain.order.payAmount, 10000, "no amount = the plan's own price");
  assert.equal(plain.order.creditNanoUsd, USD(10));
});

test("11. a manual top-up order is priced and granted the same way", async () => {
  const u = user();
  const plan = await startPlan();
  const order = await billing.createOrder({ userId: u, planId: plan.id, method: "manual", amountVnd: 30000 });
  assert.equal(order.creditNanoUsd, USD(30));
  assert.equal(order.amountNanoUsd, USD(1.2));

  await assert.rejects(
    billing.createOrder({ userId: u, planId: plan.id, method: "manual", amountVnd: 5 }),
    /tối thiểu/
  );

  await billing.approveOrder(order.id, "admin");
  const granted = db.get(`SELECT * FROM userPlans WHERE userId = ?`, [u]);
  assert.equal(granted.creditTotalNanoUsd, USD(30));
});

test("12. the bank reconciler matches a VietQR top-up against the typed amount, not the plan price", async () => {
  const u = user(); providers();
  const plan = await startPlan();
  const make = (amountVnd) => db.transaction(() => checkout.createGatewayOrderSync(db, {
    userId: u, plan, method: "vietqr", settings: SETTINGS, nowIso: at(T0), amountVnd,
  })).order;
  const provider = { id: "v1", kind: "sepay", name: "sepay", config: { accountNumber: "1017588888" } };
  const ingest = (order, amount, externalId) => db.transaction(() => reconcile.ingestTransactionSync(db, {
    provider,
    tx: {
      externalId, direction: "in", amount, currency: "VND",
      content: `MBVCB.${order.paymentCode}.CT tu 0123`, occurredAt: at(T0 + 5 * 60_000), raw: { id: externalId },
    },
    via: "webhook",
    nowIso: at(T0 + 10 * 60_000),
    settings: SETTINGS,
  }));

  const big = make(50000);
  const underpaid = make(30000);

  // The plan's own price (10.000đ) does not settle a 50.000đ order.
  const wrong = ingest(big, 10000, "ext-wrong");
  assert.equal(wrong.outcome, "needs_review");
  assert.equal(wrong.reason, "amount_mismatch");
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM userPlans`).n, 0, "no grant on a mismatch");

  const exact = ingest(big, 50000, "ext-exact");
  assert.equal(exact.outcome, "matched");
  assert.equal(db.get(`SELECT status FROM orders WHERE id = ?`, [big.id]).status, "paid");
  const granted = db.get(`SELECT * FROM userPlans WHERE userId = ?`, [u]);
  assert.equal(granted.creditTotalNanoUsd, USD(50));

  const short = ingest(underpaid, 10000, "ext-short");
  assert.equal(short.outcome, "needs_review");
  assert.equal(db.get(`SELECT status FROM orders WHERE id = ?`, [underpaid.id]).status, "pending");
});
