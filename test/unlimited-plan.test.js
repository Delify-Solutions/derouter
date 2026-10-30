// Plans with no credit ceiling (spec plan-queue-billing "Unlimited-credit plans").
//
// An unlimited plan stores 0 credit and a flag. These cases pin what a customer and
// an operator would notice: it is never refused for lack of credit, only its window
// limits stop it, it never exhausts or creates debt, every way of granting one
// carries the flag, and an operator cannot graft credit onto it.
//
// Throwaway SQLite, synchronous engine called with an explicit `now`.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-unlimited-test-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const queue = await import("../src/lib/billing/planQueue.js");
const { grantUserPlan } = await import("../src/lib/billing/grants.js");
const actions = await import("../src/lib/billing/adminActions.js");
const billing = await import("../src/lib/db/repos/billingRepo.js");
const gifts = await import("../src/lib/db/repos/giftRepo.js");
const checkout = await import("../src/lib/payments/checkout.js");
const { approveOrderSync } = await import("../src/lib/billing/orders.js");
const { NANO } = await import("../src/shared/utils/money.js");

let db;
const USD = (n) => Math.round(n * NANO);
const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 29, 10, 0, 0);
const at = (ms) => new Date(ms).toISOString();

before(async () => { db = await getAdapter(); });

after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  for (const table of [
    "userPlanWindows", "creditLedger", "userPlans", "orders", "plans",
    "giftRedemptions", "giftCodes", "apiKeys", "users", "usageHistory", "kv", "userAuditLog",
    "paymentTransactions", "paymentProviders",
  ]) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* partial schema */ }
  }
});

function user(id = "u1", { debt = 0 } = {}) {
  db.run(
    `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
     VALUES(?, ?, 'x', NULL, NULL, 'active', ?, ?, ?)`,
    [id, `${id}@test.local`, debt, at(T0), at(T0)]
  );
  return id;
}

function planRow(id, { unlimited = false, creditUsd = 250, limits = null, rpm = null } = {}) {
  db.run(
    `INSERT INTO plans(id, code, name, priceNanoUsd, creditNanoUsd, unlimitedCredit, durationDays, isActive, limits, rpm, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, 30, 1, ?, ?, ?, ?)`,
    [id, id, id.toUpperCase(), USD(10), unlimited ? 0 : USD(creditUsd), unlimited ? 1 : 0,
      limits ? JSON.stringify(limits) : null, rpm, at(T0), at(T0)]
  );
  return id;
}

function grantUnlimited({ id = "up-unl", userId = "u1", limits = [{ hours: 5, maxNanoUsd: USD(20) }], priority = null } = {}) {
  const { userPlan } = db.transaction(() =>
    grantUserPlan(db, { userId, planId: null, source: "admin", unlimitedCredit: true, durationDays: 30, limits, now: at(T0) })
  );
  db.run(`UPDATE userPlans SET id = ?, priority = ? WHERE id = ?`, [id, priority, userPlan.id]);
  db.run(`UPDATE creditLedger SET userPlanId = ? WHERE userPlanId = ?`, [id, userPlan.id]);
  return id;
}

function grantFinite({ id = "up-fin", userId = "u1", creditUsd = 10, priority = null } = {}) {
  db.run(
    `INSERT INTO userPlans(id, userId, planId, orderId, source, creditTotalNanoUsd, creditRemainingNanoUsd, startsAt, expiresAt, status, priority, limits, createdAt)
     VALUES(?, ?, NULL, NULL, 'admin', ?, ?, ?, ?, 'active', ?, NULL, ?)`,
    [id, userId, USD(creditUsd), USD(creditUsd), at(T0), at(T0 + 30 * 24 * HOUR), priority, at(T0)]
  );
  return id;
}

const charge = (userId, usd, k, nowMs) =>
  db.transaction(() => queue.chargeSync(db, { userId, requestKey: k, costNanoUsd: USD(usd), nowIso: at(nowMs) }));

const row = (id) => db.get(`SELECT * FROM userPlans WHERE id = ?`, [id]);

test("1. a charge leaves an unlimited plan's credit alone, ledgers the spend and makes no debt", () => {
  user();
  const id = grantUnlimited();
  const result = charge("u1", 3, "r1", T0 + HOUR);

  assert.equal(result.charged, USD(3));
  assert.equal(result.debtNanoUsd, 0);
  const plan = row(id);
  assert.equal(plan.creditRemainingNanoUsd, 0);
  assert.equal(plan.status, "active", "an unlimited plan never exhausts");

  const rows = db.all(`SELECT * FROM creditLedger WHERE userPlanId = ? AND kind = 'charge'`, [id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].deltaNanoUsd, -USD(3));
  assert.equal(JSON.parse(rows[0].meta).unlimited, true);
  assert.equal(db.get(`SELECT overdraftNanoUsd AS d FROM users WHERE id = 'u1'`).d, 0);
});

test("2. a full window blocks the plan with 429 and a reset time; it reopens when the window closes", () => {
  user();
  grantUnlimited({ limits: [{ hours: 5, maxNanoUsd: USD(20) }] });
  charge("u1", 20, "r1", T0 + HOUR);

  const blocked = queue.admitSync(db, "u1", at(T0 + 2 * HOUR));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.code, "plan_limit");
  assert.equal(blocked.resetAt, at(T0 + 6 * HOUR));

  assert.equal(queue.admitSync(db, "u1", at(T0 + 7 * HOUR)).ok, true);
});

test("3. a request bigger than the window's room is still paid in full by the unlimited plan", () => {
  user();
  const id = grantUnlimited({ limits: [{ hours: 5, maxNanoUsd: USD(20) }] });
  charge("u1", 19, "r1", T0 + HOUR);
  const result = charge("u1", 5, "r2", T0 + 2 * HOUR);

  assert.equal(result.debtNanoUsd, 0, "no debt while an unlimited plan is queued");
  const spent = db.get(`SELECT spentNanoUsd AS s FROM userPlanWindows WHERE userPlanId = ? AND hours = 5`, [id]).s;
  assert.equal(spent, USD(24), "the overshoot is recorded so the next request is blocked");
  assert.equal(queue.admitSync(db, "u1", at(T0 + 3 * HOUR)).status, 429);
});

test("4. a finite plan behind an unlimited one only pays what the window cannot", () => {
  user();
  const unl = grantUnlimited({ limits: [{ hours: 5, maxNanoUsd: USD(1) }], priority: 1 });
  const fin = grantFinite({ creditUsd: 10, priority: 2 });

  charge("u1", 0.5, "r1", T0 + HOUR);
  assert.equal(row(fin).creditRemainingNanoUsd, USD(10), "within the window the finite plan is untouched");

  charge("u1", 3, "r2", T0 + 2 * HOUR);
  // The unlimited plan had $0.50 of room left; the finite plan paid the other $2.50.
  assert.equal(row(fin).creditRemainingNanoUsd, USD(7.5));
  const spent = db.get(`SELECT spentNanoUsd AS s FROM userPlanWindows WHERE userPlanId = ? AND hours = 5`, [unl]).s;
  assert.equal(spent, USD(1));
});

test("5. window counters equal what rebuildWindowsSync replays from the ledger", () => {
  user();
  const id = grantUnlimited({ limits: [{ hours: 5, maxNanoUsd: USD(20) }, { hours: 168, maxNanoUsd: USD(100) }] });
  charge("u1", 4, "r1", T0 + HOUR);
  charge("u1", 6, "r2", T0 + 2 * HOUR);
  charge("u1", 2, "r3", T0 + 9 * HOUR);

  const nowMs = T0 + 10 * HOUR;
  const rebuilt = queue.rebuildWindowsSync(db, id, at(nowMs));
  for (const hours of [5, 168]) {
    const stored = db.get(`SELECT * FROM userPlanWindows WHERE userPlanId = ? AND hours = ?`, [id, hours]);
    assert.equal(stored.spentNanoUsd, rebuilt[hours].spentNanoUsd, `window ${hours}h`);
    assert.equal(stored.startedAt, rebuilt[hours].startedAt, `window ${hours}h start`);
  }
});

test("6. validatePlanInput: unlimited needs a bound; finite still needs credit", () => {
  const base = { code: "unl", name: "Unl", priceNanoUsd: USD(10), durationDays: 30 };
  assert.match(billing.validatePlanInput({ ...base, unlimitedCredit: true }) || "", /ít nhất một hạn mức/);
  assert.equal(billing.validatePlanInput({ ...base, unlimitedCredit: true, limits: [{ hours: 5, maxNanoUsd: USD(20) }] }), null);
  assert.equal(billing.validatePlanInput({ ...base, unlimitedCredit: true, rpm: 60 }), null);
  assert.equal(billing.validatePlanInput({ ...base, unlimitedCredit: true, tpm: 100000 }), null);
  assert.equal(billing.validatePlanInput({ ...base, unlimitedCredit: true, rpm: 0, tpm: "" }) !== null, true, "0 and blank are not a bound");
  assert.match(billing.validatePlanInput({ ...base }) || "", /creditNanoUsd/);
  assert.equal(billing.validatePlanInput({ ...base, creditNanoUsd: USD(5) }), null);
});

test("7. createPlan stores 0 credit; the order snapshots the flag and approving grants an unlimited purchase", async () => {
  const u = user();
  const created = await billing.createPlan({
    code: "unl", name: "Unlimited", priceNanoUsd: USD(30), creditNanoUsd: USD(999), unlimitedCredit: true,
    durationDays: 30, limits: [{ hours: 5, maxNanoUsd: USD(20) }],
  });
  assert.equal(created.unlimitedCredit, true);
  assert.equal(created.creditNanoUsd, 0, "whatever credit was sent, an unlimited plan stores 0");

  const order = await billing.createOrder({ userId: u, planId: created.id, method: "manual" });
  assert.equal(db.get(`SELECT unlimitedCredit AS f FROM orders WHERE id = ?`, [order.id]).f, 1);

  // Editing the plan afterwards must not change what this order grants.
  await billing.updatePlan(created.id, { unlimitedCredit: false, creditNanoUsd: USD(50) });
  await billing.approveOrder(order.id, "admin");

  const granted = db.get(`SELECT * FROM userPlans WHERE userId = ?`, [u]);
  assert.equal(granted.unlimitedCredit, 1);
  assert.equal(granted.creditTotalNanoUsd, 0);

  const wallet = await billing.walletSummary(u);
  assert.equal(wallet.hasUnlimitedCredit, true);
});

test("8. buying an unlimited plan does not repay debt: there is no credit to take it from", () => {
  user("u1", { debt: USD(4) });
  grantUnlimited();
  assert.equal(db.get(`SELECT overdraftNanoUsd AS d FROM users WHERE id = 'u1'`).d, USD(4));
  assert.equal(queue.admitSync(db, "u1", at(T0 + HOUR)).ok, true, "admission ignores debt while an unlimited plan can pay");
});

test("9. an admin grant carries the flag; adjusting credit on it is refused; revoke closes it quietly", () => {
  user();
  planRow("p-unl", { unlimited: true, limits: [{ hours: 5, maxNanoUsd: USD(20) }] });
  const granted = db.transaction(() =>
    actions.grantPlanSync(db, "u1", { planId: "p-unl", reason: "support grant", now: at(T0) })
  );
  assert.equal(granted.ok, true);
  assert.equal(granted.userPlan.unlimitedCredit, 1);

  const id = granted.userPlan.id;
  const adjust = db.transaction(() =>
    actions.adjustCreditSync(db, "u1", id, { deltaNanoUsd: USD(5), reason: "try to add credit", now: at(T0) })
  );
  assert.equal(adjust.ok, false);
  assert.equal(adjust.status, 409);
  assert.equal(row(id).creditRemainingNanoUsd, 0);

  const revoked = db.transaction(() =>
    actions.revokePlanSync(db, "u1", id, { reason: "chargeback", now: at(T0 + HOUR) })
  );
  assert.equal(revoked.ok, true);
  assert.equal(row(id).status, "revoked");
  assert.equal(
    db.all(`SELECT * FROM creditLedger WHERE userPlanId = ? AND kind = 'revoke'`, [id]).length,
    0,
    "nothing was forfeited, so no revoke row"
  );
});

test("10. an unlimited purchase cannot be left with neither a limit nor a plan rate", () => {
  user();
  planRow("p-unl", { unlimited: true, limits: [{ hours: 5, maxNanoUsd: USD(20) }] });
  const id = db.transaction(() => actions.grantPlanSync(db, "u1", { planId: "p-unl", reason: "support grant", now: at(T0) })).userPlan.id;

  const cleared = db.transaction(() =>
    actions.setPurchaseLimitsSync(db, "u1", id, { limits: [], reason: "remove the cap", now: at(T0) })
  );
  assert.equal(cleared.ok, false);
  assert.equal(cleared.status, 400);

  // A plan RPM stands in for the window limit.
  db.run(`UPDATE plans SET rpm = 60 WHERE id = 'p-unl'`);
  const allowed = db.transaction(() =>
    actions.setPurchaseLimitsSync(db, "u1", id, { limits: [], reason: "rpm is the cap now", now: at(T0) })
  );
  assert.equal(allowed.ok, true);
});

test("11. applying empty limits to active purchases skips unlimited ones that would be left unbounded", () => {
  user();
  planRow("p-unl", { unlimited: true, limits: [{ hours: 5, maxNanoUsd: USD(20) }] });
  const id = db.transaction(() => actions.grantPlanSync(db, "u1", { planId: "p-unl", reason: "support grant", now: at(T0) })).userPlan.id;

  const applied = db.transaction(() => actions.applyLimitsToActiveSync(db, "p-unl", [], { actor: "admin" }));
  assert.equal(applied.ok, true);
  assert.equal(applied.affectedCount, 0);
  assert.deepEqual(JSON.parse(row(id).limits), [{ hours: 5, maxNanoUsd: USD(20) }]);
});

test("12. a plan gift of an unlimited plan grants an unlimited purchase", async () => {
  user();
  planRow("p-unl", { unlimited: true, limits: [{ hours: 5, maxNanoUsd: USD(20) }] });
  const gift = await gifts.createGiftCode({ planId: "p-unl", maxRedemptions: 1 });
  const result = db.transaction(() => gifts.redeemGiftCode(db, { userId: "u1", code: gift.code }));
  assert.equal(result.ok, true);
  assert.equal(result.userPlan.unlimitedCredit, 1);
  assert.equal(result.userPlan.creditTotalNanoUsd, 0);
});

test("13. the expiry sweep closes an unlimited plan without a forfeited amount", () => {
  user();
  const id = grantUnlimited();
  const swept = db.transaction(() => billing.expireStalePlans(db, at(T0 + 31 * 24 * HOUR)));
  assert.equal(swept.expired, 1);
  assert.equal(swept.forfeitedNanoUsd, 0);
  assert.equal(row(id).status, "expired");
  assert.equal(queue.admitSync(db, "u1", at(T0 + 32 * 24 * HOUR)).status, 402);
});

test("14. refunding an unlimited order closes the purchase and takes nothing back", async () => {
  const u = user();
  const created = await billing.createPlan({
    code: "unl-refund", name: "Unlimited", priceNanoUsd: USD(30), unlimitedCredit: true,
    durationDays: 30, rpm: 60,
  });
  const order = await billing.createOrder({ userId: u, planId: created.id, method: "manual" });
  await billing.approveOrder(order.id, "admin");

  const refunded = await billing.refundOrder(order.id, { adminId: "admin" });
  assert.equal(refunded.refundedNanoUsd, 0);
  const closed = db.get(`SELECT status FROM userPlans WHERE userId = ?`, [u]);
  assert.equal(closed.status, "refunded");
  assert.equal(queue.admitSync(db, u, at(Date.now())).status, 402);
});

test("15. a VietQR gateway order snapshots the flag and approving it grants an unlimited purchase", () => {
  user();
  db.run(
    `INSERT INTO plans(id, code, name, priceNanoUsd, priceVnd, creditNanoUsd, unlimitedCredit, durationDays, isActive, isPurchasable, limits, createdAt, updatedAt)
     VALUES('p-gw', 'p-gw', 'GW', ?, 750000, 0, 1, 30, 1, 1, ?, ?, ?)`,
    [USD(30), JSON.stringify([{ hours: 5, maxNanoUsd: USD(20) }]), at(T0), at(T0)]
  );
  db.run(
    `INSERT INTO paymentProviders(id, kind, name, isActive, sortOrder, config, secrets, pollIntervalSeconds, createdAt, updatedAt)
     VALUES('v1', 'sepay', 'sepay', 1, 0, ?, '{}', 30, ?, ?)`,
    [JSON.stringify({ accountNumber: "1017588888", bankBin: "970436", bankName: "Vietcombank" }), at(T0), at(T0)]
  );
  const plan = db.get(`SELECT * FROM plans WHERE id = 'p-gw'`);

  const result = checkout.createGatewayOrderSync(db, {
    userId: "u1",
    plan: { ...plan, isActive: true, isPurchasable: true, priceVnd: 750000, limits: [{ hours: 5, maxNanoUsd: USD(20) }] },
    method: "vietqr",
    settings: { paymentCodePrefix: "DR", paymentOrderTtlMinutes: 30 },
    nowIso: at(T0),
  });
  assert.equal(result.ok, true);
  assert.equal(db.get(`SELECT unlimitedCredit AS f FROM orders WHERE id = ?`, [result.order.id]).f, 1);

  const approved = db.transaction(() => approveOrderSync(db, result.order.id, { approvedBy: "reconciler", now: at(T0 + 60_000) }));
  assert.equal(approved.userPlan.unlimitedCredit, 1);
  const granted = db.get(`SELECT * FROM userPlans WHERE userId = 'u1'`);
  assert.equal(granted.unlimitedCredit, 1);
  assert.equal(granted.creditTotalNanoUsd, 0);
  assert.deepEqual(JSON.parse(granted.limits), [{ hours: 5, maxNanoUsd: USD(20) }]);
});
