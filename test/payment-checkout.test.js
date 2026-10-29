// Checkout (design D5, specs/payment-checkout + plan-dual-pricing, task 5.5).
//
// Covers every scenario of specs/payment-checkout except the page UI: offered
// methods, code uniqueness, the amount/currency snapshot, the TTL, the pending
// limit and the expiry sweep feeding the monthly purchase limit.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-payment-checkout-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const checkout = await import("../src/lib/payments/checkout.js");
const { planPurchaseBlocker } = await import("../src/lib/db/repos/billingRepo.js");
const { NANO } = await import("../src/shared/utils/money.js");

let db;
const USD = (n) => Math.round(n * NANO);
const T0 = Date.UTC(2026, 9, 29, 10, 0, 0);
const at = (ms) => new Date(ms).toISOString();
const MIN = 60 * 1000;

const SETTINGS = { paymentCodePrefix: "DR", paymentOrderTtlMinutes: 30, allowManualOrders: true };

before(async () => { db = await getAdapter(); });

after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  for (const table of ["paymentTransactions", "paymentProviders", "userPlans", "orders", "plans", "users", "creditLedger", "kv"]) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* partial schema */ }
  }
});

// ── Fixtures ────────────────────────────────────────────────────────────────

function user(id = "u1", { groupId = null } = {}) {
  db.run(
    `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
     VALUES(?, ?, 'x', NULL, ?, 'active', 0, ?, ?)`,
    [id, `${id}@test.local`, groupId, at(T0), at(T0)]
  );
  return id;
}

function plan(id = "p1", overrides = {}) {
  const values = {
    code: id,
    name: id.toUpperCase(),
    priceNanoUsd: USD(10),
    priceVnd: 250000,
    creditNanoUsd: USD(250),
    durationDays: 30,
    purchaseLimitPerMonth: null,
    ...overrides,
  };
  db.run(
    `INSERT INTO plans(id, code, name, priceNanoUsd, priceVnd, creditNanoUsd, durationDays, isActive, isPurchasable, purchaseLimitPerMonth, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`,
    [
      id, values.code, values.name, values.priceNanoUsd, values.priceVnd,
      values.creditNanoUsd, values.durationDays, values.purchaseLimitPerMonth, at(T0), at(T0),
    ]
  );
  return db.get(`SELECT * FROM plans WHERE id = ?`, [id]);
}

function provider(id, kind, { isActive = 1, sortOrder = 0, accountNumber = "1017588888" } = {}) {
  db.run(
    `INSERT INTO paymentProviders(id, kind, name, isActive, sortOrder, config, secrets, pollIntervalSeconds, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, '{}', 30, ?, ?)`,
    [id, kind, `${kind}-${id}`, isActive, sortOrder, JSON.stringify({ accountNumber, bankBin: "970436", bankName: "Vietcombank", apiBase: "https://web2m.test/api" }), at(T0), at(T0)]
  );
}

/** A plan row in the shape `rowToPlan` produces (what offeredMethodsSync receives). */
function planShape(row) {
  return {
    ...row,
    isActive: true,
    isPurchasable: true,
    priceNanoUsd: Number(row.priceNanoUsd),
    priceVnd: row.priceVnd == null ? null : Number(row.priceVnd),
    creditNanoUsd: Number(row.creditNanoUsd),
    durationDays: Number(row.durationDays),
    limits: [],
  };
}

// ── Offered methods ────────────────────────────────────────────────────────

test("a plan with both prices and both providers offers vietqr, binance and manual", () => {
  user(); const row = plan();
  provider("v1", "sepay");
  provider("b1", "binance");

  const methods = checkout.offeredMethodsSync(db, planShape(row), SETTINGS).map((m) => m.method);
  assert.deepEqual(methods, ["vietqr", "binance", "manual"]);
});

test("no Binance provider means the plan does not offer binance", () => {
  user(); const row = plan();
  provider("v1", "sepay");

  const methods = checkout.offeredMethodsSync(db, planShape(row), SETTINGS);
  assert.deepEqual(methods.map((m) => m.method), ["vietqr", "manual"]);
});

test("a zero VND price means the plan is not sold by VietQR", () => {
  user(); const row = plan("p1", { priceVnd: 0 });
  provider("v1", "sepay");
  provider("b1", "binance");

  const methods = checkout.offeredMethodsSync(db, planShape(row), SETTINGS).map((m) => m.method);
  assert.deepEqual(methods, ["binance", "manual"]);
});

test("manual is not offered when the setting is off", () => {
  user(); const row = plan();
  provider("v1", "sepay");

  const methods = checkout.offeredMethodsSync(db, planShape(row), { ...SETTINGS, allowManualOrders: false })
    .map((m) => m.method);
  assert.deepEqual(methods, ["vietqr"]);
});

test("an inactive provider offers nothing", () => {
  user(); const row = plan();
  provider("v1", "sepay", { isActive: 0 });
  provider("b1", "binance", { isActive: 0 });

  const methods = checkout.offeredMethodsSync(db, planShape(row), SETTINGS).map((m) => m.method);
  assert.deepEqual(methods, ["manual"], "manual needs no provider");
});

test("the VietQR provider is the lowest sort order across all VND kinds", () => {
  user(); const row = plan();
  provider("w1", "web2m", { sortOrder: 0 });
  provider("s1", "sepay", { sortOrder: 5 });

  const vietqr = checkout.offeredMethodsSync(db, planShape(row), SETTINGS).find((m) => m.method === "vietqr");
  assert.equal(vietqr.providerId, "w1");
});

test("display strings are the ones spec plan-dual-pricing asks for", () => {
  user(); const row = plan();
  provider("v1", "sepay");
  provider("b1", "binance");

  const byMethod = Object.fromEntries(
    checkout.offeredMethodsSync(db, planShape(row), SETTINGS).map((m) => [m.method, m])
  );
  assert.equal(byMethod.vietqr.amountText, "250.000đ");
  assert.equal(byMethod.binance.amountText, "$10");
  assert.equal(byMethod.manual.amountText, "$10");
});

// ── Creating an order ──────────────────────────────────────────────────────

test("a VietQR order snapshots currency, amount, provider, code and expiry", () => {
  user(); const row = plan();
  provider("v1", "sepay");

  const result = checkout.createGatewayOrderSync(db, {
    userId: "u1",
    plan: planShape(row),
    method: "vietqr",
    settings: SETTINGS,
    nowIso: at(T0),
  });

  assert.equal(result.ok, true);
  const order = result.order;
  assert.equal(order.status, "pending");
  assert.equal(order.method, "vietqr");
  assert.equal(order.payCurrency, "VND");
  assert.equal(order.payAmount, 250000);
  assert.equal(order.paymentProviderId, "v1");
  assert.match(order.paymentCode, /^DR[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  assert.equal(order.expiresAt, at(T0 + 30 * MIN));
  assert.equal(order.amountNanoUsd, USD(10), "the USD price keeps its existing meaning");
  assert.equal(order.creditNanoUsd, USD(250), "credit is snapshotted");
});

test("a Binance order uses the plan's USD price as nano-USDT", () => {
  user(); const row = plan("p1", { priceNanoUsd: USD(10.5) });
  provider("b1", "binance");

  const result = checkout.createGatewayOrderSync(db, {
    userId: "u1", plan: planShape(row), method: "binance", settings: SETTINGS, nowIso: at(T0),
  });

  assert.equal(result.ok, true);
  assert.equal(result.order.payCurrency, "USDT");
  assert.equal(result.order.payAmount, 10_500_000_000);
});

test("a method the plan does not offer is refused", () => {
  user(); const row = plan("p1", { priceNanoUsd: 0 });
  provider("v1", "sepay");

  const result = checkout.createGatewayOrderSync(db, {
    userId: "u1", plan: planShape(row), method: "binance", settings: SETTINGS, nowIso: at(T0),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "not_offered");
  assert.equal(result.status, 400);
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM orders`).n, 0);
});

test("codes are unique across orders", () => {
  user(); const row = plan();
  provider("v1", "sepay");
  const codes = new Set();
  for (let i = 0; i < 25; i += 1) {
    // Each call must not be blocked by the pending limit for this test; expire the
    // previous one instead of parallelising.
    db.run(`UPDATE orders SET status = 'expired'`);
    const result = checkout.createGatewayOrderSync(db, {
      userId: "u1", plan: planShape(row), method: "vietqr", settings: SETTINGS, nowIso: at(T0),
    });
    assert.equal(result.ok, true);
    codes.add(result.order.paymentCode);
  }
  assert.equal(codes.size, 25);
});

test("the TTL setting decides expiresAt", () => {
  user(); const row = plan();
  provider("v1", "sepay");

  const result = checkout.createGatewayOrderSync(db, {
    userId: "u1", plan: planShape(row), method: "vietqr",
    settings: { ...SETTINGS, paymentOrderTtlMinutes: 90 }, nowIso: at(T0),
  });
  assert.equal(result.order.expiresAt, at(T0 + 90 * MIN));
});

test("the TTL is clamped to the documented 10–1440 minutes", () => {
  assert.equal(checkout.clampTtl(1), 10);
  assert.equal(checkout.clampTtl(5000), 1440);
  assert.equal(checkout.clampTtl("nonsense"), 30);
  assert.equal(checkout.clampTtl(45), 45);
});

// ── Pending limit ──────────────────────────────────────────────────────────

test("a sixth pending gateway order is refused with 429", () => {
  user(); const row = plan();
  provider("v1", "sepay");

  for (let i = 0; i < 5; i += 1) {
    const result = checkout.createGatewayOrderSync(db, {
      userId: "u1", plan: planShape(row), method: "vietqr", settings: SETTINGS, nowIso: at(T0 + i * 1000),
    });
    assert.equal(result.ok, true, `order ${i + 1} should be created`);
  }

  const sixth = checkout.createGatewayOrderSync(db, {
    userId: "u1", plan: planShape(row), method: "vietqr", settings: SETTINGS, nowIso: at(T0),
  });
  assert.equal(sixth.ok, false);
  assert.equal(sixth.status, 429);
  assert.equal(sixth.error, checkout.PENDING_LIMIT_MESSAGE);
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM orders`).n, 5);
});

test("manual orders do not count toward the pending gateway limit", () => {
  user(); const row = plan();
  provider("v1", "sepay");
  for (let i = 0; i < 5; i += 1) {
    db.run(
      `INSERT INTO orders(id, userId, planId, amountNanoUsd, creditNanoUsd, durationDays, status, method, payCurrency, payAmount, createdAt)
       VALUES(?, 'u1', 'p1', ?, ?, 30, 'pending', 'manual', 'USD', ?, ?)`,
      [`m${i}`, USD(10), USD(250), USD(10), at(T0)]
    );
  }
  const result = checkout.createGatewayOrderSync(db, {
    userId: "u1", plan: planShape(row), method: "vietqr", settings: SETTINGS, nowIso: at(T0),
  });
  assert.equal(result.ok, true);
});

// ── Expiry ─────────────────────────────────────────────────────────────────

test("the expiry sweep flips only pending gateway orders past their window", () => {
  user(); const row = plan();
  provider("v1", "sepay");
  const created = checkout.createGatewayOrderSync(db, {
    userId: "u1", plan: planShape(row), method: "vietqr", settings: SETTINGS, nowIso: at(T0),
  });
  // A manual order has no window and must not be swept.
  db.run(
    `INSERT INTO orders(id, userId, planId, amountNanoUsd, creditNanoUsd, durationDays, status, method, createdAt)
     VALUES('manual-1', 'u1', 'p1', ?, ?, 30, 'pending', 'manual', ?)`,
    [USD(10), USD(250), at(T0)]
  );
  // A paid gateway order must never be expired by a clock.
  db.run(
    `INSERT INTO orders(id, userId, planId, amountNanoUsd, creditNanoUsd, durationDays, status, method, payCurrency, payAmount, paymentCode, expiresAt, createdAt)
     VALUES('paid-1', 'u1', 'p1', ?, ?, 30, 'paid', 'vietqr', 'VND', 250000, 'DRPAID00000', ?, ?)`,
    [USD(10), USD(250), at(T0), at(T0)]
  );

  const before = checkout.expireGatewayOrdersSync(db, at(T0 + 29 * MIN));
  assert.deepEqual(before, [], "29 minutes is still inside the window");

  const expired = checkout.expireGatewayOrdersSync(db, at(T0 + 31 * MIN));
  assert.deepEqual(expired, [created.order.id]);
  assert.equal(db.get(`SELECT status FROM orders WHERE id = ?`, [created.order.id]).status, "expired");
  assert.equal(db.get(`SELECT status FROM orders WHERE id = 'manual-1'`).status, "pending");
  assert.equal(db.get(`SELECT status FROM orders WHERE id = 'paid-1'`).status, "paid");
});

test("an expired order does not count toward the monthly purchase limit", async () => {
  user(); const row = plan("p1", { purchaseLimitPerMonth: 1 });
  provider("v1", "sepay");

  const first = checkout.createGatewayOrderSync(db, {
    userId: "u1", plan: planShape(row), method: "vietqr", settings: SETTINGS, nowIso: at(T0),
  });
  assert.equal(first.ok, true);

  const blocked = await planPurchaseBlocker(
    db,
    planShape(row),
    { id: "u1", groupId: null },
    new Date(T0 + 1000)
  );
  assert.equal(blocked.code, "purchase_limit", "a pending order consumes the slot");

  db.run(`UPDATE orders SET status = 'expired' WHERE id = ?`, [first.order.id]);
  const allowedAgain = await planPurchaseBlocker(
    db,
    planShape(row),
    { id: "u1", groupId: null },
    new Date(T0 + 2000)
  );
  assert.equal(allowedAgain, null, "an expired order frees the slot");
});

test("an expired order frees a pending-limit slot as well", () => {
  user(); const row = plan();
  provider("v1", "sepay");
  for (let i = 0; i < 5; i += 1) {
    checkout.createGatewayOrderSync(db, {
      userId: "u1", plan: planShape(row), method: "vietqr", settings: SETTINGS, nowIso: at(T0),
    });
  }
  assert.equal(checkout.countPendingGatewayOrdersSync(db, "u1"), 5);
  checkout.expireGatewayOrdersSync(db, at(T0 + 31 * MIN));
  assert.equal(checkout.countPendingGatewayOrdersSync(db, "u1"), 0);
});
