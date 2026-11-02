// Multi-period terms, unlimited stacking and gifts in the monthly limit
// (spec plan-terms).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-plan-terms-"));
// DATA_DIR must be set before the DB driver is imported.
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const repo = await import("../src/lib/db/repos/billingRepo.js");
const terms = await import("../src/lib/billing/terms.js");
const { grantUserPlan } = await import("../src/lib/billing/grants.js");
const { admitSync, chargeSync, queueViewSync } = await import("../src/lib/billing/planQueue.js");
const { grantPlanSync, revokePlanSync } = await import("../src/lib/billing/adminActions.js");
const checkout = await import("../src/lib/payments/checkout.js");

let db;
const USD = (n) => Math.round(n * 1e9);
const DAY = 86_400_000;

before(async () => { db = await getAdapter(); });
after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(() => {
  for (const table of ["userPlanWindows", "creditLedger", "userPlans", "orders", "plans", "paymentProviders", "users", "auditLog"]) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* table may not exist */ }
  }
});

function user(id = "u1") {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
     VALUES(?, ?, 'x', NULL, NULL, 'active', 0, ?, ?)`,
    [id, `${id}@test.local`, now, now]
  );
  return id;
}

let planSeq = 0;
async function plan(overrides = {}) {
  planSeq += 1;
  return repo.createPlan({
    code: `plan-${planSeq}`,
    name: `Plan ${planSeq}`,
    priceNanoUsd: USD(10),
    priceVnd: 250000,
    creditNanoUsd: USD(100),
    durationDays: 30,
    ...overrides,
  });
}

const unlimitedPlan = (overrides = {}) => plan({
  unlimitedCredit: true,
  creditNanoUsd: 0,
  limits: [{ hours: 5, maxNanoUsd: USD(5) }],
  ...overrides,
});

const rowsOf = (userId) => db.all(
  `SELECT * FROM userPlans WHERE userId = ? ORDER BY startsAt ASC`,
  [userId]
);

// ── Pricing ─────────────────────────────────────────────────────────────────

test("a term is priced price × periods × (100 − discount)%, in both currencies", () => {
  const p = { priceNanoUsd: USD(10), priceVnd: 250000 };
  const price = terms.termPrice(p, { periods: 3, discountPercent: 5 });
  assert.equal(price.priceNanoUsd, USD(28.5));
  assert.equal(price.priceVnd, 712500);
  assert.equal(price.fullPriceVnd, 750000);
  assert.equal(terms.termPrice({ priceNanoUsd: USD(10), priceVnd: null }, { periods: 12, discountPercent: 15 }).priceVnd, null);
});

test("term labels read as months for a monthly plan, days otherwise", () => {
  assert.equal(terms.termLabel(30, 1), "1 tháng");
  assert.equal(terms.termLabel(30, 12), "12 tháng");
  assert.equal(terms.termLabel(90, 2), "6 tháng");
  assert.equal(terms.termLabel(7, 4), "28 ngày");
});

test("the admin's term list is validated with Vietnamese messages", async () => {
  assert.equal(terms.validateTermOptions([{ periods: 3, discountPercent: 5 }]), null);
  assert.match(terms.validateTermOptions([{ periods: 1 }]), /từ 2 đến/);
  assert.match(terms.validateTermOptions([{ periods: 3 }, { periods: 3 }]), /lặp/);
  assert.match(terms.validateTermOptions([{ periods: 3, discountPercent: 95 }]), /% giảm/);
  assert.match(terms.validateTermOptions([{ periods: 3 }], { allowCustomAmount: true }), /tùy ý/);
  await assert.rejects(() => plan({ termOptions: [{ periods: 0 }] }), /Số kỳ/);

  const saved = await plan({ termOptions: [{ periods: 12, discountPercent: 15 }, { periods: 3, discountPercent: 5 }] });
  assert.deepEqual(saved.termOptions, [{ periods: 3, discountPercent: 5 }, { periods: 12, discountPercent: 15 }], "sorted");
  const cleared = await repo.updatePlan(saved.id, { termOptions: [] });
  assert.deepEqual(cleared.termOptions, []);
});

// ── Orders and grants ───────────────────────────────────────────────────────

test("a 3-period order charges the discounted total and grants 3 back-to-back purchases", async () => {
  const userId = user();
  const p = await plan({ termOptions: [{ periods: 3, discountPercent: 5 }] });

  const order = await repo.createOrder({ userId, planId: p.id, periods: 3 });
  assert.equal(order.periods, 3);
  assert.equal(order.discountPercent, 5);
  assert.equal(order.amountNanoUsd, USD(28.5));
  assert.equal(order.creditNanoUsd, USD(100), "credit stays per period");

  const result = await repo.approveOrder(order.id);
  assert.equal(result.userPlans.length, 3);
  const rows = rowsOf(userId);
  assert.equal(rows.length, 3);
  for (let i = 0; i < 3; i += 1) {
    assert.equal(Number(rows[i].creditTotalNanoUsd), USD(100));
    assert.equal(rows[i].orderId, order.id);
    assert.equal(new Date(rows[i].expiresAt) - new Date(rows[i].startsAt), 30 * DAY);
    if (i > 0) assert.equal(rows[i].startsAt, rows[i - 1].expiresAt, "each period starts when the previous ends");
  }

  // Only the first period is spendable today.
  assert.equal(await repo.getAvailableNanoUsd(userId), USD(100));
  const view = queueViewSync(db, userId);
  assert.deepEqual(view.map((e) => e.statusLabel), ["paying", "scheduled", "scheduled"]);
});

test("a term the plan does not sell is refused", async () => {
  const userId = user();
  const p = await plan({ termOptions: [{ periods: 3, discountPercent: 5 }] });
  await assert.rejects(() => repo.createOrder({ userId, planId: p.id, periods: 6 }), /kỳ hạn/);
  const plain = await plan();
  await assert.rejects(() => repo.createOrder({ userId, planId: plain.id, periods: 3 }), /kỳ hạn/);
});

test("a later period pays nothing until it starts, then pays like any purchase", async () => {
  const userId = user();
  const now = Date.now();
  grantUserPlan(db, {
    userId, source: "purchase", creditNanoUsd: USD(1), durationDays: 30, periods: 2,
    now: new Date(now).toISOString(),
  });
  const [first, second] = rowsOf(userId);

  // The first period runs dry: the second has not started, so the rest is debt.
  const charge = chargeSync(db, { userId, requestKey: "r1", costNanoUsd: USD(3), nowIso: new Date(now + DAY).toISOString() });
  assert.deepEqual(charge.parts.map((part) => part.userPlanId), [first.id]);
  assert.equal(charge.debtNanoUsd, USD(2));
  assert.equal(admitSync(db, userId, new Date(now + DAY).toISOString()).status, 402);

  // Once its start passes, the second period is the one that pays.
  const later = new Date(new Date(second.startsAt).getTime() + 1000).toISOString();
  assert.equal(admitSync(db, userId, later).planId, second.id);
});

// ── Unlimited stacking ──────────────────────────────────────────────────────

test("an unlimited plan given while the same one runs starts when it ends", async () => {
  const userId = user();
  const p = await unlimitedPlan();
  const bought = await repo.createOrder({ userId, planId: p.id });
  await repo.approveOrder(bought.id);
  const [running] = rowsOf(userId);

  const gift = grantUserPlan(db, {
    userId, planId: p.id, source: "gift", creditNanoUsd: 0, unlimitedCredit: true,
    durationDays: 30, limits: p.limits,
  });
  assert.equal(gift.userPlan.startsAt, running.expiresAt, "queued behind the running one");
  assert.deepEqual(queueViewSync(db, userId).map((e) => e.statusLabel), ["paying", "scheduled"]);

  // Admin grants and a second purchase stack behind the last one in turn.
  const granted = grantPlanSync(db, userId, { planId: p.id, reason: "bù lỗi" });
  assert.equal(granted.userPlan.startsAt, gift.userPlan.expiresAt);
});

test("an unlimited plan of a different plan, or a finite plan, starts right away", async () => {
  const userId = user();
  const a = await unlimitedPlan();
  const b = await unlimitedPlan();
  const finite = await plan();
  grantPlanSync(db, userId, { planId: a.id, reason: "test a" });
  const other = grantPlanSync(db, userId, { planId: b.id, reason: "test b" });
  const credit = grantPlanSync(db, userId, { planId: finite.id, reason: "test c" });
  const createdNow = (row) => Math.abs(new Date(row.startsAt) - Date.now()) < 5000;
  assert.ok(createdNow(other.userPlan));
  assert.ok(createdNow(credit.userPlan));
});

test("a multi-period unlimited order stacks behind the running one, every period", async () => {
  const userId = user();
  const p = await unlimitedPlan({ termOptions: [{ periods: 3, discountPercent: 10 }] });
  const running = grantPlanSync(db, userId, { planId: p.id, reason: "existing" }).userPlan;
  const order = await repo.createOrder({ userId, planId: p.id, periods: 3 });
  const { userPlans } = await repo.approveOrder(order.id);
  assert.equal(userPlans[0].startsAt, running.expiresAt);
  assert.equal(userPlans[2].expiresAt, new Date(new Date(running.expiresAt).getTime() + 90 * DAY).toISOString());
});

// ── Monthly purchase limit ──────────────────────────────────────────────────

test("a gifted plan uses the month's purchase slot; revoking it gives the slot back", async () => {
  const userId = user();
  const p = await unlimitedPlan({ purchaseLimitPerMonth: 1 });
  const buyer = { id: userId, groupId: null };
  assert.equal(await repo.planPurchaseBlocker(db, p, buyer), null);

  const gift = grantUserPlan(db, {
    userId, planId: p.id, source: "gift", creditNanoUsd: 0, unlimitedCredit: true, durationDays: 30, limits: p.limits,
  });
  const blocked = await repo.planPurchaseBlocker(db, p, buyer);
  assert.equal(blocked?.code, "purchase_limit");
  assert.equal(blocked.used, 1);

  const revoked = revokePlanSync(db, userId, gift.userPlan.id, { reason: "thu hồi thử" });
  assert.equal(revoked.ok, true);
  assert.equal(await repo.planPurchaseBlocker(db, p, buyer), null);
});

test("a multi-period order counts once toward the monthly limit", async () => {
  const userId = user();
  const p = await plan({ purchaseLimitPerMonth: 2, termOptions: [{ periods: 3, discountPercent: 0 }] });
  const order = await repo.createOrder({ userId, planId: p.id, periods: 3 });
  await repo.approveOrder(order.id);
  const blocker = await repo.planPurchaseBlocker(db, p, { id: userId, groupId: null });
  assert.equal(blocker, null, "1 of 2 used, not 3");
});

// ── Gateway checkout ────────────────────────────────────────────────────────

test("a gateway order for 3 periods asks for the discounted amount", async () => {
  const userId = user();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO paymentProviders(id, kind, name, isActive, sortOrder, config, secrets, pollIntervalSeconds, createdAt, updatedAt)
     VALUES('v1', 'sepay', 'sepay', 1, 0, ?, '{}', 30, ?, ?)`,
    [JSON.stringify({ accountNumber: "1017588888", bankBin: "970436", bankName: "Vietcombank" }), now, now]
  );
  const p = await plan({ termOptions: [{ periods: 3, discountPercent: 5 }] });

  const created = db.transaction(() => checkout.createGatewayOrderSync(db, {
    userId, plan: p, method: "vietqr", settings: { paymentCodePrefix: "DR" }, periods: 3,
  }));
  assert.equal(created.ok, true);
  assert.equal(created.order.payAmount, 712500);
  assert.equal(created.order.amountNanoUsd, USD(28.5));
  assert.equal(created.order.periods, 3);

  const bad = db.transaction(() => checkout.createGatewayOrderSync(db, {
    userId, plan: p, method: "vietqr", settings: { paymentCodePrefix: "DR" }, periods: 6,
  }));
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "bad_term");
});
