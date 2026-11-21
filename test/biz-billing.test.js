// Product-line billing (spec plan-queue-billing "Purchases are scoped to the key's
// product line", spec plan-templates "Plan definition").
//
// The rule under test is one sentence: a key only ever sees its own line's
// purchases. Everything a customer would notice follows from it — a bot key with
// only an api plan gets the business 402, an api key cannot drain a business
// purchase, gift credit stays on the api line, and pinning narrows within the line
// rather than across it.
//
// Runs against a throwaway SQLite database; every function under test is
// synchronous and takes the adapter, so `now` is always explicit.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-biz-billing-test-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const queue = await import("../src/lib/billing/planQueue.js");
const { payingRatesSync } = await import("../src/lib/billing/rates.js");
const discounts = await import("../src/lib/billing/discounts.js");
const billing = await import("../src/lib/db/repos/billingRepo.js");
const { NANO } = await import("../src/shared/utils/money.js");

let db;
const USD = (n) => Math.round(n * NANO);
const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 3, 10, 0, 0);
const at = (ms) => new Date(ms).toISOString();
const plus = (ms, hours) => at(ms + hours * HOUR);
const days = (n) => n * 24 * HOUR;

before(async () => { db = await getAdapter(); });

after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  for (const table of [
    "userPlanWindows", "creditLedger", "userPlans", "orders", "plans",
    "apiKeys", "users", "usageHistory", "kv", "combos", "modelDiscounts",
  ]) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* partial schema */ }
  }
});

// ── Fixtures ────────────────────────────────────────────────────────────────

function user(id = "u1") {
  db.run(
    `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
     VALUES(?, ?, 'x', NULL, NULL, 'active', 0, ?, ?)`,
    [id, `${id}@test.local`, at(T0), at(T0)]
  );
}

function plan(id, { productLine = "api", maxBots = null, maxKbBytes = null, rpm = null, creditUsd = 250 } = {}) {
  db.run(
    `INSERT INTO plans(id, code, name, priceNanoUsd, creditNanoUsd, durationDays, isActive, rpm, productLine, maxBots, maxKbBytes, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, 30, 1, ?, ?, ?, ?, ?, ?)`,
    [id, id, id.toUpperCase(), USD(10), USD(creditUsd), rpm, productLine, maxBots, maxKbBytes, at(T0), at(T0)]
  );
}

function purchase(userId, planId, { creditUsd = 100, expiresInHours = days(1).valueOf() / HOUR, startsAt = at(T0) } = {}) {
  const id = `up_${Math.random().toString(36).slice(2, 10)}`;
  db.run(
    `INSERT INTO userPlans(id, userId, planId, orderId, source, creditTotalNanoUsd, creditRemainingNanoUsd, startsAt, expiresAt, status, createdAt)
     VALUES(?, ?, ?, NULL, 'purchase', ?, ?, ?, ?, 'active', ?)`,
    [id, userId, planId, USD(creditUsd), USD(creditUsd), startsAt, plus(T0, expiresInHours), at(T0)]
  );
  return id;
}

function grant(userId, creditUsd) {
  const id = `up_gift_${Math.random().toString(36).slice(2, 10)}`;
  db.run(
    `INSERT INTO userPlans(id, userId, planId, orderId, source, creditTotalNanoUsd, creditRemainingNanoUsd, startsAt, expiresAt, status, createdAt)
     VALUES(?, ?, NULL, NULL, 'gift', ?, ?, ?, ?, 'active', ?)`,
    [id, userId, USD(creditUsd), USD(creditUsd), at(T0), plus(T0, days(1).valueOf() / HOUR), at(T0)]
  );
  return id;
}

function grantTo(userPlanId) {
  const dbrow = db.get(`SELECT creditRemainingNanoUsd FROM userPlans WHERE id = ?`, [userPlanId]);
  return Number(dbrow?.creditRemainingNanoUsd) || 0;
}

// ── scopeQueue ──────────────────────────────────────────────────────────────

test("scopeQueue keeps only the key's line, and credit-only grants count as api", () => {
  user("u-scope");
  plan("p-api", { productLine: "api" });
  plan("p-biz", { productLine: "business", maxBots: 1, maxKbBytes: 1024 * 1024 });
  const apiPurchase = purchase("u-scope", "p-api");
  const bizPurchase = purchase("u-scope", "p-biz");
  const gift = grant("u-scope", 5);

  const all = queue.listQueueSync(db, "u-scope", at(T0));
  const api = queue.scopeQueue(all, null, "api").map((entry) => entry.id);
  const business = queue.scopeQueue(all, null, "business").map((entry) => entry.id);

  assert.deepEqual(new Set(business), new Set([bizPurchase]));
  assert.deepEqual(new Set(api), new Set([apiPurchase, gift]));
});

test("pinning narrows within the line, never across it", () => {
  user("u-pin");
  plan("p-api", { productLine: "api" });
  plan("p-biz", { productLine: "business", maxBots: 1, maxKbBytes: 1024 * 1024 });
  purchase("u-pin", "p-api");
  purchase("u-pin", "p-biz");

  const all = queue.listQueueSync(db, "u-pin", at(T0));
  // A business key pinned to an api plan sees nothing at all.
  assert.deepEqual(queue.scopeQueue(all, "p-api", "business"), []);
  // An api key pinned to an api plan sees exactly that plan.
  assert.equal(queue.scopeQueue(all, "p-api", "api").length, 1);
});

test("productLineOfKey reads the botId", () => {
  assert.equal(queue.productLineOfKey({ botId: "b1" }), "business");
  assert.equal(queue.productLineOfKey({ botId: null }), "api");
  assert.equal(queue.productLineOfKey({}), "api");
  assert.equal(queue.productLineOfKey(null), "api");
});

// ── Admission, rates and charging ───────────────────────────────────────────

test("a bot key with only an api purchase has nothing to be admitted against", () => {
  user("u-bot");
  plan("p-api", { productLine: "api" });
  purchase("u-bot", "p-api", { creditUsd: 50 });

  const api = queue.admitSync(db, "u-bot", at(T0), { productLine: "api" });
  assert.equal(api.ok, true);

  const business = queue.admitSync(db, "u-bot", at(T0), { productLine: "business" });
  assert.equal(business.ok, false);
  assert.equal(business.status, 402);
  assert.equal(business.code, "insufficient_quota");
});

test("gift credit stays on the api line", () => {
  user("u-gift");
  grant("u-gift", 20);

  assert.equal(queue.admitSync(db, "u-gift", at(T0), { productLine: "api" }).ok, true);
  assert.equal(queue.admitSync(db, "u-gift", at(T0), { productLine: "business" }).ok, false);
});

test("a charge never crosses lines", () => {
  user("u-charge");
  plan("p-api", { productLine: "api" });
  plan("p-biz", { productLine: "business", maxBots: 1, maxKbBytes: 1024 * 1024 });
  const apiPurchase = purchase("u-charge", "p-api", { creditUsd: 10 });
  const bizPurchase = purchase("u-charge", "p-biz", { creditUsd: 10 });

  // An api request costs 15 USD: it drains the api purchase and the shortfall
  // becomes debt; the business purchase must be untouched.
  db.transaction(() => {
    queue.chargeSync(db, {
      userId: "u-charge", requestKey: "r1", costNanoUsd: USD(15), nowIso: at(T0), productLine: "api",
    });
  });
  assert.equal(grantTo(bizPurchase), USD(10));
  assert.equal(grantTo(apiPurchase), 0);

  // The business line still has its own 10 USD for a bot key.
  const business = queue.admitSync(db, "u-charge", at(T0), { productLine: "business" });
  assert.equal(business.ok, true);
});

test("an api key does not drain the business purchase, and reports insufficient quota", () => {
  user("u-drain");
  plan("p-api", { productLine: "api" });
  plan("p-biz", { productLine: "business", maxBots: 1, maxKbBytes: 1024 * 1024 });
  const apiPurchase = purchase("u-drain", "p-api", { creditUsd: 1 });
  const bizPurchase = purchase("u-drain", "p-biz", { creditUsd: 50 });

  // Exhaust the api purchase.
  db.transaction(() => {
    queue.chargeSync(db, { userId: "u-drain", requestKey: "r1", costNanoUsd: USD(1), nowIso: at(T0), productLine: "api" });
  });
  assert.equal(grantTo(apiPurchase), 0);

  const denied = queue.admitSync(db, "u-drain", at(T0), { productLine: "api" });
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 402);
  assert.equal(grantTo(bizPurchase), USD(50), "the business purchase is unchanged");
});

test("rates come from the paying plan of the key's line", () => {
  user("u-rates");
  plan("p-api", { productLine: "api", rpm: 60 });
  plan("p-biz", { productLine: "business", maxBots: 1, maxKbBytes: 1024 * 1024, rpm: 7 });
  purchase("u-rates", "p-api");
  purchase("u-rates", "p-biz");

  assert.equal(payingRatesSync(db, "u-rates", at(T0), { productLine: "api" }).rpm, 60);
  const business = payingRatesSync(db, "u-rates", at(T0), { productLine: "business" });
  assert.equal(business.rpm, 7);
  assert.equal(business.planId, "p-biz");
});

test("ratePlanIdSync picks the line's plan", () => {
  user("u-rpid");
  plan("p-api", { productLine: "api" });
  plan("p-biz", { productLine: "business", maxBots: 1, maxKbBytes: 1024 * 1024 });
  purchase("u-rpid", "p-api");
  purchase("u-rpid", "p-biz");

  assert.equal(queue.ratePlanIdSync(db, "u-rpid", null, at(T0), "api"), "p-api");
  assert.equal(queue.ratePlanIdSync(db, "u-rpid", null, at(T0), "business"), "p-biz");
});

test("a plan-scoped discount follows the line's paying plan, never the other line", () => {
  user("u-disc");
  plan("p-api", { productLine: "api" });
  plan("p-biz", { productLine: "business", maxBots: 1, maxKbBytes: 1024 * 1024 });
  purchase("u-disc", "p-api");
  purchase("u-disc", "p-biz");

  // A plan-scoped rule may only name models that exist as combos.
  db.run(
    `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES('c-a', 'model-a', 'llm', '["a/b"]', ?, ?)`,
    [at(T0), at(T0)]
  );

  // 50% off only while the api purchase is the one paying.
  const created = db.transaction(() => discounts.createDiscountSync(db, {
    scopeType: "plan",
    scopeId: "p-api",
    percent: "50",
    models: ["model-a"],
  }, { now: at(T0) }));
  assert.equal(created.ok, true, JSON.stringify(created));

  const apiCharge = db.transaction(() => discounts.applyRequestDiscountSync(db, {
    listCostNanoUsd: USD(10), at: at(T0), requestedModel: "model-a", userId: "u-disc", productLine: "api",
  }));
  assert.equal(apiCharge.discountBp, 5000, "the api line sees its own plan's rule");

  const bizCharge = db.transaction(() => discounts.applyRequestDiscountSync(db, {
    listCostNanoUsd: USD(10), at: at(T0), requestedModel: "model-a", userId: "u-disc", productLine: "business",
  }));
  assert.equal(bizCharge.discountBp, 0, "the business line does not inherit an api plan's rule");
  assert.equal(bizCharge.costNanoUsd, USD(10));
});

test("a charge stays idempotent per requestKey across lines", () => {
  user("u-idem");
  plan("p-biz", { productLine: "business", maxBots: 1, maxKbBytes: 1024 * 1024 });
  const purchaseId = purchase("u-idem", "p-biz", { creditUsd: 10 });

  const first = db.transaction(() =>
    queue.chargeSync(db, { userId: "u-idem", requestKey: "same", costNanoUsd: USD(2), nowIso: at(T0), productLine: "business" })
  );
  const again = db.transaction(() =>
    queue.chargeSync(db, { userId: "u-idem", requestKey: "same", costNanoUsd: USD(2), nowIso: at(T0), productLine: "business" })
  );
  assert.equal(first.charged, USD(2));
  assert.equal(again.alreadyCharged, true);
  assert.equal(grantTo(purchaseId), USD(8));
});

// ── Plan storage ────────────────────────────────────────────────────────────

test("a business plan stores both limits; an api plan stores NULL", async () => {
  const business = await billing.createPlan({
    code: "biz-start",
    name: "Biz Start",
    priceNanoUsd: USD(30),
    creditNanoUsd: USD(100),
    durationDays: 30,
    productLine: "business",
    maxBots: 2,
    maxKbBytes: 20 * 1024 * 1024,
  });
  assert.equal(business.productLine, "business");
  assert.equal(business.maxBots, 2);
  assert.equal(business.maxKbBytes, 20 * 1024 * 1024);

  const api = await billing.createPlan({
    code: "go",
    name: "Go",
    priceNanoUsd: USD(10),
    creditNanoUsd: USD(250),
    durationDays: 30,
    productLine: "api",
    maxBots: 5,
    maxKbBytes: 5 * 1024 * 1024,
  });
  assert.equal(api.productLine, "api");
  assert.equal(api.maxBots, null);
  assert.equal(api.maxKbBytes, null);

  // Every plan written before the column existed reads as api.
  const listed = await billing.listPlans();
  assert.ok(listed.every((plan) => plan.productLine === "api" || plan.productLine === "business"));
  const fetched = await billing.getPlanByCode("go");
  assert.equal(fetched.productLine, "api");
});

test("a business plan without a bot limit is refused", () => {
  const invalid = billing.validatePlanInput({
    code: "biz-bad",
    name: "Biz Bad",
    priceNanoUsd: USD(30),
    creditNanoUsd: USD(100),
    durationDays: 30,
    productLine: "business",
  });
  assert.match(invalid, /số bot tối đa/);
});

test("an invalid product line is refused", () => {
  const invalid = billing.validateProductLineInput({ productLine: "reseller" });
  assert.match(invalid, /Dòng sản phẩm/);
});

test("patching a plan without productLine keeps its line", async () => {
  const created = await billing.createPlan({
    code: "biz-keep",
    name: "Biz Keep",
    priceNanoUsd: USD(30),
    creditNanoUsd: USD(100),
    durationDays: 30,
    productLine: "business",
    maxBots: 3,
    maxKbBytes: 10 * 1024 * 1024,
  });
  const current = await billing.getPlanById(created.id);
  const merged = { ...current, description: "Đổi mô tả" };
  const invalid = billing.validatePlanInput(merged);
  assert.equal(invalid, null);

  const updated = db.transaction(() => billing.updatePlanSync(db, created.id, { description: "Đổi mô tả" }));
  assert.equal(updated.productLine, "business");
  assert.equal(updated.maxBots, 3);
  assert.equal(updated.maxKbBytes, 10 * 1024 * 1024);
});
