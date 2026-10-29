// Dual pricing: VND price on plans, per-currency revenue, and the payment block
// the order page renders (specs/plan-dual-pricing + task 8.3/9.2 acceptance).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-payment-pricing-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const billing = await import("../src/lib/db/repos/billingRepo.js");
const { buildPaymentBlock, buildVietQrUrl } = await import("../src/lib/payments/orderPayment.js");
const { NANO } = await import("../src/shared/utils/money.js");

let db;
const USD = (n) => Math.round(n * NANO);
const T0 = Date.UTC(2026, 9, 29, 10, 0, 0);
const at = (ms) => new Date(ms).toISOString();

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

function user() {
  db.run(
    `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
     VALUES('u1', 'u1@test.local', 'x', NULL, NULL, 'active', 0, ?, ?)`,
    [at(T0), at(T0)]
  );
}

function paidOrder({ id, planId = "p1", payCurrency, payAmount, amountNanoUsd = USD(10) }) {
  db.run(
    `INSERT INTO orders(id, userId, planId, amountNanoUsd, creditNanoUsd, durationDays, status, method, payCurrency, payAmount, createdAt, paidAt)
     VALUES(?, 'u1', ?, ?, ?, 30, 'paid', 'vietqr', ?, ?, ?, ?)`,
    [id, planId, amountNanoUsd, USD(250), payCurrency, payAmount, at(T0), at(T0)]
  );
}

const PLAN_INPUT = {
  code: "go",
  name: "Go",
  priceNanoUsd: USD(10),
  priceVnd: 250000,
  creditNanoUsd: USD(250),
  durationDays: 30,
};

// ── priceVnd on the plan ───────────────────────────────────────────────────

test("a plan stores and returns priceVnd alongside the USD price", async () => {
  const plan = await billing.createPlan(PLAN_INPUT);
  assert.equal(plan.priceVnd, 250000);
  assert.equal(plan.priceNanoUsd, USD(10));

  const reloaded = await billing.getPlanById(plan.id);
  assert.equal(reloaded.priceVnd, 250000);
});

test("a negative priceVnd is refused and changes nothing", async () => {
  const plan = await billing.createPlan(PLAN_INPUT);
  assert.equal(billing.validatePlanInput({ ...PLAN_INPUT, priceVnd: -1 }), "priceVnd must be a non-negative integer (đồng)");

  await assert.rejects(
    () => billing.updatePlan(plan.id, { priceVnd: -1 }),
    /priceVnd/
  );
  const reloaded = await billing.getPlanById(plan.id);
  assert.equal(reloaded.priceVnd, 250000, "the stored value must survive a rejected patch");
});

test("priceVnd must be an integer, and 0 means 'not sold by VietQR'", async () => {
  assert.equal(
    billing.validatePlanInput({ ...PLAN_INPUT, priceVnd: 1.5 }),
    "priceVnd must be a non-negative integer (đồng)"
  );
  const plan = await billing.createPlan({ ...PLAN_INPUT, priceVnd: 0 });
  assert.equal(plan.priceVnd, null, "0 is stored as NULL: one representation of 'no VND price'");
});

test("priceVnd can be cleared and set again", async () => {
  const plan = await billing.createPlan(PLAN_INPUT);
  const cleared = await billing.updatePlan(plan.id, { priceVnd: null });
  assert.equal(cleared.priceVnd, null);
  const restored = await billing.updatePlan(plan.id, { priceVnd: 300000 });
  assert.equal(restored.priceVnd, 300000);
});

// ── Revenue per currency ───────────────────────────────────────────────────

test("revenue is reported per currency, refunds excluded", async () => {
  user();
  const plan = await billing.createPlan(PLAN_INPUT);

  paidOrder({ id: "o1", planId: plan.id, payCurrency: "VND", payAmount: 250000 });
  paidOrder({ id: "o2", planId: plan.id, payCurrency: "USDT", payAmount: USD(10), amountNanoUsd: USD(10) });
  // A manual order: payCurrency USD, payAmount = amountNanoUsd.
  paidOrder({ id: "o3", planId: plan.id, payCurrency: "USD", payAmount: USD(20), amountNanoUsd: USD(20) });
  // Refunded: must not appear in either figure.
  db.run(
    `INSERT INTO orders(id, userId, planId, amountNanoUsd, creditNanoUsd, durationDays, status, method, payCurrency, payAmount, createdAt)
     VALUES('o4', 'u1', ?, ?, ?, 30, 'refunded', 'vietqr', 'VND', 250000, ?)`,
    [plan.id, USD(10), USD(250), at(T0)]
  );

  const stats = await billing.planStats();
  const entry = stats.get(plan.id);
  assert.equal(entry.revenueVnd, 250000, "one 250,000đ VietQR order");
  assert.equal(entry.revenueUsdNano, USD(30), "10 USDT + 20 USD manual");
  assert.equal(entry.revenueNanoUsd, USD(30), "the combined figure keeps its old meaning");
});

test("a pre-split order with NULL payCurrency falls into the USD figure", async () => {
  user();
  const plan = await billing.createPlan(PLAN_INPUT);
  db.run(
    `INSERT INTO orders(id, userId, planId, amountNanoUsd, creditNanoUsd, durationDays, status, method, createdAt)
     VALUES('legacy', 'u1', ?, ?, ?, 30, 'paid', 'manual', ?)`,
    [plan.id, USD(10), USD(250), at(T0)]
  );

  const entry = (await billing.planStats()).get(plan.id);
  assert.equal(entry.revenueVnd, 0);
  assert.equal(entry.revenueUsdNano, USD(10));
});

test("a plan with no paid orders reports zero in both currencies", async () => {
  user();
  const plan = await billing.createPlan(PLAN_INPUT);
  const entry = (await billing.planStats()).get(plan.id) ?? {
    revenueVnd: 0, revenueUsdNano: 0, revenueNanoUsd: 0, activeCount: 0, activeUsers: 0, consumedNanoUsd: 0,
  };
  assert.equal(entry.revenueVnd, 0);
  assert.equal(entry.revenueUsdNano, 0);
});

// ── Payment block for the order page ───────────────────────────────────────

const VIETQR_PROVIDER = {
  id: "prov1",
  kind: "sepay",
  name: "VCB",
  config: { bankBin: "970436", bankName: "Vietcombank", accountNumber: "1017588888", accountName: "NGUYEN VAN A" },
};

test("a VietQR payment block carries the QR URL, amount and every copy field", () => {
  const order = {
    id: "o1", paymentCode: "DR8K3Q7MZP", payCurrency: "VND", payAmount: 250000,
  };
  const block = buildPaymentBlock({ order, provider: VIETQR_PROVIDER });

  assert.equal(block.method, "vietqr");
  assert.equal(block.amountText, "250.000đ");
  assert.equal(block.content, "DR8K3Q7MZP");
  assert.equal(block.bankName, "Vietcombank");
  assert.equal(block.accountNumber, "1017588888");
  assert.equal(block.accountName, "NGUYEN VAN A");
  assert.match(block.qrUrl, /^https:\/\/img\.vietqr\.io\/image\/970436-1017588888-compact2\.png\?/);
  assert.match(block.qrUrl, /amount=250000/);
  assert.match(block.qrUrl, /addInfo=DR8K3Q7MZP/);
  assert.match(block.instruction, /Nhập đúng nội dung chuyển khoản/);
});

test("a Binance payment block carries UID, USDT amount and the Note instruction", () => {
  const order = {
    id: "o2", paymentCode: "DRAAAA2222", payCurrency: "USDT", payAmount: 10_500_000_000,
  };
  const block = buildPaymentBlock({
    order,
    provider: { id: "p2", kind: "binance", name: "Binance", config: { payUid: "34355667", qrImageUrl: "https://x/qr.png", accountName: "Alan" } },
  });

  assert.equal(block.method, "binance");
  assert.equal(block.amountUsdt, "10.5");
  assert.equal(block.amountText, "10.5 USDT");
  assert.equal(block.payUid, "34355667");
  assert.equal(block.qrImageUrl, "https://x/qr.png");
  assert.equal(block.content, "DRAAAA2222");
  assert.match(block.instruction, /Ghi mã vào ô Note/);
});

test("a manual order has no payment block", () => {
  const block = buildPaymentBlock({
    order: { id: "o3", paymentCode: null, payCurrency: "USD", payAmount: USD(10) },
    provider: VIETQR_PROVIDER,
  });
  assert.equal(block, null);
});

test("a VietQR block without a bank BIN still renders the copy fields", () => {
  const block = buildPaymentBlock({
    order: { id: "o4", paymentCode: "DRXXXX3333", payCurrency: "VND", payAmount: 1000 },
    provider: { id: "p4", kind: "web2m", name: "web2m", config: { accountNumber: "0123" } },
  });
  assert.equal(block.qrUrl, null, "no QR image without a BIN");
  assert.equal(block.accountNumber, "0123");
  assert.equal(block.amountText, "1.000đ");
});

test("buildVietQrUrl returns null without the two identifiers it needs", () => {
  assert.equal(buildVietQrUrl({ bankBin: "", accountNumber: "1", amount: 1, content: "X" }), null);
  assert.equal(buildVietQrUrl({ bankBin: "970436", accountNumber: "", amount: 1, content: "X" }), null);
});
