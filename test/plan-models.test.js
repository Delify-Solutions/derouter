// A plan decides which models it includes (change plan-model-access).
//
// Three things must hold, and each one is a way this feature can be wrong:
//   1. a plan NARROWS the buyer's group, never widens it;
//   2. the purchase that PAYS for a request is one that includes its model, at
//      admission AND at charge time (the queue is re-read there);
//   3. an ineligible purchase is skipped, not reported as a full window.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dr-plan-models-"));
process.env.DATA_DIR = dir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const { runMigrationOnce } = await import("../src/lib/db/migrate.js");
const { createPlan, updatePlan, createOrder, approveOrder, getPlanById } = await import("../src/lib/db/repos/billingRepo.js");
const { createKeyGroup } = await import("../src/lib/db/repos/keyGroupsRepo.js");
const { createCombo } = await import("../src/lib/db/repos/combosRepo.js");
const { createUser } = await import("../src/lib/db/repos/userRepo.js");
const { grantUserPlan } = await import("../src/lib/billing/grants.js");
const { admitSync, chargeSync, listQueueSync } = await import("../src/lib/billing/planQueue.js");
const { effectiveModels, effectiveAllows, planAllowsModel, unionOfModels, normalizePlanModels } = await import("../src/lib/billing/planModels.js");
const { customerModelScopeSync, livePurchaseModelsSync } = await import("../src/lib/billing/customerModels.js");
const { applyModelsToActiveSync } = await import("../src/lib/billing/adminActions.js");
const { createGatewayOrderSync } = await import("../src/lib/payments/checkout.js");
const { approveOrderSync } = await import("../src/lib/billing/orders.js");
const { createApiKey } = await import("../src/lib/db/repos/apiKeysRepo.js");
const { enforceKeyLimits } = await import("../src/lib/auth/keyEnforcement.js");
const { getQueueSync } = await import("../src/lib/db/repos/accountPlansRepo.js");

const db = await getAdapter();
await runMigrationOnce(db);

// A plan's list names combos, and the API refuses a name that does not exist — so
// the fixtures create the combos they refer to.
async function combo(name) {
  const existing = db.get(`SELECT name FROM combos WHERE name = ?`, [name]);
  if (!existing) await createCombo({ name, models: [`test/${name}`] });
  return name;
}

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// ── the pure rules ─────────────────────────────────────────────────────────

test("a null or empty list means no restriction", () => {
  assert.equal(normalizePlanModels(null), null);
  assert.equal(normalizePlanModels([]), null);
  assert.equal(planAllowsModel(null, "anything"), true);
  assert.deepEqual(normalizePlanModels([" a ", "A", "b"]), ["a", "b"]);
});

test("the matching is the group's own, so a provider prefix collapses", () => {
  // The point is not that any two similar ids match, but that a plan list built in
  // the picker (combo names) answers requests sent with a provider-prefixed id,
  // using the very function the group allow-list uses.
  assert.equal(planAllowsModel(["claude-sonnet"], "anthropic/claude-sonnet"), true);
  assert.equal(planAllowsModel(["claude-sonnet"], "claude-sonnet"), true);
  assert.equal(planAllowsModel(["claude-sonnet"], "gpt-5"), false);
});

test("a plan never widens the group", () => {
  // group allows x only; the plan lists x and y -> only x survives
  assert.deepEqual(effectiveModels(["x"], ["x", "y"]), ["x"]);
  // group allows everything -> the plan is the only bound
  assert.deepEqual(effectiveModels(null, ["x", "y"]), ["x", "y"]);
  // the plan restricts nothing -> the group stands
  assert.deepEqual(effectiveModels(["x"], null), ["x"]);
  // both empty -> nothing callable, and that is NOT "unrestricted"
  assert.deepEqual(effectiveModels(["x"], ["z"]), []);
  assert.equal(effectiveAllows([], "x"), false);
  assert.equal(effectiveAllows(null, "x"), true);
});

test("one unrestricted purchase opens the whole set", () => {
  assert.equal(unionOfModels([{ allowedModels: ["a"] }, { allowedModels: null }]), null);
  assert.deepEqual(unionOfModels([{ allowedModels: ["a"] }, { allowedModels: ["b", "a"] }]), ["a", "b"]);
});

// ── storage ────────────────────────────────────────────────────────────────

test("a plan stores its model list, and an empty one is refused", async () => {
  const comboX = await combo("combo-x");
  const plan = await createPlan({
    code: "pm_store", name: "Store", priceNanoUsd: 1e10, creditNanoUsd: 2e11,
    durationDays: 30, allowedModels: [comboX],
  });
  assert.deepEqual(plan.allowedModels, [comboX]);
  assert.deepEqual((await getPlanById(plan.id)).allowedModels, [comboX]);

  await assert.rejects(
    () => updatePlan(plan.id, { allowedModels: [] }),
    /allowedModels/
  );
  // null clears it back to unrestricted
  assert.equal((await updatePlan(plan.id, { allowedModels: null })).allowedModels, null);
});

// ── admission and charging ─────────────────────────────────────────────────

async function setup({ groupModels = null, planModels = null, creditNanoUsd = 1e11, code = "pm" } = {}) {
  const suffix = Math.random().toString(36).slice(2, 8);
  for (const name of [...(groupModels ?? []), ...(planModels ?? [])]) await combo(name);
  const group = await createKeyGroup({ name: `g-${suffix}`, allowedModels: groupModels });
  const user = await createUser({ email: `u-${suffix}@example.com`, passwordHash: "x", status: "active", groupId: group.id });
  const plan = await createPlan({
    code: `${code}_${suffix}`, name: "P", priceNanoUsd: 0, creditNanoUsd,
    durationDays: 30, allowedModels: planModels,
  });
  const granted = grantUserPlan(db, {
    userId: user.id, planId: plan.id, source: "admin",
    creditNanoUsd, durationDays: 30,
    allowedModels: planModels,
  });
  return { group, user, plan, userPlan: granted.userPlan };
}

test("admission picks the purchase that includes the model", async () => {
  const { user } = await setup({ planModels: ["gpt-5"], code: "a" });
  // a second, cheaper purchase that only covers claude, queued FIRST
  await combo("claude-sonnet");
  const planB = await createPlan({
    code: `b_${Math.random().toString(36).slice(2, 8)}`, name: "B", priceNanoUsd: 0,
    creditNanoUsd: 1e11, durationDays: 30, allowedModels: ["claude-sonnet"],
  });
  const first = grantUserPlan(db, {
    userId: user.id, planId: planB.id, source: "admin",
    creditNanoUsd: 1e11, durationDays: 30, allowedModels: ["claude-sonnet"],
  });

  // `gpt-5` may only be paid by the other purchase, whatever the queue order says.
  const forGpt = admitSync(db, user.id, null, { model: "gpt-5" });
  assert.equal(forGpt.ok, true);
  assert.notEqual(forGpt.planId, first.userPlan.id);

  const forClaude = admitSync(db, user.id, null, { model: "claude-sonnet" });
  assert.equal(forClaude.ok, true);
  assert.equal(forClaude.planId, first.userPlan.id);
});

test("a purchase that does not include the model never pays for it", async () => {
  const { user, userPlan } = await setup({ planModels: ["claude-sonnet"], code: "c" });
  const result = await chargeSync(db, {
    userId: user.id,
    amountNanoUsd: 1_000_000_000,
    requestKey: `req-${Math.random()}`,
    nowIso: new Date().toISOString(),
    model: "gpt-5",
  });
  // Nothing eligible -> the cost is not silently billed to the wrong purchase.
  const after = listQueueSync(db, user.id).find((e) => e.id === userPlan.id);
  assert.equal(after.creditRemainingNanoUsd, 1e11);
  assert.equal(result.chargedNanoUsd ?? 0, 0);
});

test("an ineligible purchase is not a reason to report 429", async () => {
  const { user } = await setup({ planModels: ["claude-sonnet"], code: "d" });
  // The only purchase covers claude; asking for gpt-5 is 402 (nothing to charge),
  // no reopen time is offered because waiting would not help.
  const verdict = admitSync(db, user.id, null, { model: "gpt-5" });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, 402);
});

// ── the effective set against the database ─────────────────────────────────

test("the scope is the group narrowed by the live purchases", async () => {
  const { user } = await setup({ groupModels: ["a", "b", "c"], planModels: ["a", "b"], code: "e" });
  assert.deepEqual(customerModelScopeSync(db, user.id, ["a", "b", "c"]), ["a", "b"]);
  // a purchase list outside the group leaves nothing callable
  const { user: other } = await setup({ groupModels: ["a"], planModels: ["z"], code: "f" });
  assert.deepEqual(customerModelScopeSync(db, other.id, ["a"]), []);
  const live = livePurchaseModelsSync(db, other.id);
  assert.equal(live.liveCount, 1);
});

test("two purchases give the union, and expiry removes its own models", async () => {
  const { user, userPlan } = await setup({ planModels: ["a"], code: "g" });
  grantUserPlan(db, {
    userId: user.id, planId: null, source: "admin",
    creditNanoUsd: 1e11, durationDays: 30, allowedModels: ["b"],
  });
  assert.deepEqual(customerModelScopeSync(db, user.id, null), ["a", "b"]);

  // Expiring the first purchase drops `a` from the scope.
  db.run(`UPDATE userPlans SET expiresAt = ? WHERE id = ?`, ["2000-01-01T00:00:00.000Z", userPlan.id]);
  assert.deepEqual(customerModelScopeSync(db, user.id, null), ["b"]);
});

test("no live purchase keeps the group's list", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const group = await createKeyGroup({ name: `g-${suffix}`, allowedModels: ["a", "b"] });
  const user = await createUser({ email: `n-${suffix}@example.com`, passwordHash: "x", status: "active", groupId: group.id });
  assert.deepEqual(customerModelScopeSync(db, user.id, ["a", "b"]), ["a", "b"]);
});

// ── snapshots ──────────────────────────────────────────────────────────────

test("an order snapshots the model list and the purchase keeps it", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  await combo("a");
  const group = await createKeyGroup({ name: `g-${suffix}` });
  const user = await createUser({ email: `o-${suffix}@example.com`, passwordHash: "x", status: "active", groupId: group.id });
  const plan = await createPlan({
    code: `o_${suffix}`, name: "O", priceNanoUsd: 1e9, creditNanoUsd: 1e11,
    durationDays: 30, allowedModels: ["a"],
  });
  const order = await createOrder({ userId: user.id, planId: plan.id });
  assert.deepEqual(order.allowedModels, ["a"]);

  // The admin edits the plan before approving; the order keeps what was sold.
  await updatePlan(plan.id, { allowedModels: ["a", "b"] });
  const approved = await approveOrder(order.id, "tester");
  assert.deepEqual(approved.userPlan.allowedModels, ["a"]);
});

// The gateway (VietQR / Binance) checkout inserts its own order row: it must freeze the list too,
// or a plan sold as "Claude only" is granted with no restriction on the main purchase path.
test("a gateway checkout order snapshots the model list and the purchase keeps it", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  await combo("a");
  const group = await createKeyGroup({ name: `g-${suffix}` });
  const user = await createUser({ email: `gw-${suffix}@example.com`, passwordHash: "x", status: "active", groupId: group.id });
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO paymentProviders(id, kind, name, isActive, sortOrder, config, secrets, pollIntervalSeconds, createdAt, updatedAt)
     VALUES(?, 'sepay', 'sepay', 1, 0, ?, '{}', 30, ?, ?)`,
    [`gw-${suffix}`, JSON.stringify({ accountNumber: "1017588888", bankBin: "970436", bankName: "Vietcombank" }), now, now]
  );
  const plan = await createPlan({
    code: `gw_${suffix}`, name: "GW", priceNanoUsd: 1e9, priceVnd: 25000, creditNanoUsd: 1e11,
    durationDays: 30, allowedModels: ["a"],
  });
  const created = db.transaction(() => createGatewayOrderSync(db, {
    userId: user.id, plan, method: "vietqr", settings: { paymentCodePrefix: "DR" },
  }));
  assert.equal(created.ok, true);
  assert.deepEqual(JSON.parse(db.get(`SELECT allowedModels FROM orders WHERE id = ?`, [created.order.id]).allowedModels), ["a"]);

  // The admin widens the plan before the payment arrives; the order keeps what was sold.
  await updatePlan(plan.id, { allowedModels: ["a", "b"] });
  const approved = db.transaction(() => approveOrderSync(db, created.order.id, { approvedBy: "tester" }));
  const row = db.get(`SELECT allowedModels FROM userPlans WHERE orderId = ?`, [created.order.id]);
  assert.ok(approved);
  assert.deepEqual(JSON.parse(row.allowedModels), ["a"]);
});

test("a gateway checkout order of an unrestricted plan stores no list", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const group = await createKeyGroup({ name: `g-${suffix}` });
  const user = await createUser({ email: `gu-${suffix}@example.com`, passwordHash: "x", status: "active", groupId: group.id });
  const plan = await createPlan({ code: `gu_${suffix}`, name: "GU", priceNanoUsd: 1e9, priceVnd: 25000, creditNanoUsd: 1e11, durationDays: 30 });
  const created = db.transaction(() => createGatewayOrderSync(db, {
    userId: user.id, plan, method: "vietqr", settings: { paymentCodePrefix: "DR" },
  }));
  assert.equal(created.ok, true);
  assert.equal(db.get(`SELECT allowedModels FROM orders WHERE id = ?`, [created.order.id]).allowedModels, null);
});

test("applyToActive is the only way an edit reaches live purchases", async () => {
  const { plan, userPlan, user } = await setup({ planModels: ["a"], code: "h" });
  // Without the flag: the purchase is untouched.
  await updatePlan(plan.id, { allowedModels: ["a", "b"] });
  let row = db.get(`SELECT allowedModels FROM userPlans WHERE id = ?`, [userPlan.id]);
  assert.deepEqual(JSON.parse(row.allowedModels), ["a"]);

  const applied = applyModelsToActiveSync(db, plan.id, ["a", "b"], { actor: "tester" });
  assert.equal(applied.ok, true);
  assert.equal(applied.affectedCount, 1);
  row = db.get(`SELECT allowedModels FROM userPlans WHERE id = ?`, [userPlan.id]);
  assert.deepEqual(JSON.parse(row.allowedModels), ["a", "b"]);

  // The audit trail records who moved it and why.
  const audit = db.all(
    `SELECT action, details FROM userAuditLog WHERE userId = ? AND action = 'plan_models_changed'`,
    [user.id]
  );
  assert.equal(audit.length, 1);
  assert.deepEqual(JSON.parse(audit[0].details).after, ["a", "b"]);

  // Running it again with the same list changes nothing.
  assert.equal(applyModelsToActiveSync(db, plan.id, ["a", "b"], { actor: "tester" }).affectedCount, 0);
});

// ── enforcement ────────────────────────────────────────────────────────────

test("a customer key is refused 403 for a model no live purchase includes", async () => {
  const { user, group } = await setup({ groupModels: ["a", "b"], planModels: ["a"], code: "i" });
  const key = await createApiKey("k", "test", { userId: user.id });
  assert.ok(group.allowedModels.includes("b"));

  // `a` is in the plan and the group -> passes the access check (admission then
  // decides quota, which is a different answer).
  assert.notEqual((await enforceKeyLimits(key.key, "a", {})).status, 403);

  // `b` is in the group but in no live purchase -> 403, not 402: buying credit is
  // not the fix, a plan that includes the model is.
  const denied = await enforceKeyLimits(key.key, "b", {});
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 403);
  assert.equal(denied.code, "model_not_allowed");
});

test("a group refusal stays 403 even when a purchase lists the model", async () => {
  const { user } = await setup({ groupModels: ["a"], planModels: ["a", "b"], code: "j" });
  const key = await createApiKey("k2", "test", { userId: user.id });
  // The plan names `b`, the group does not: the plan cannot widen the group.
  const denied = await enforceKeyLimits(key.key, "b", {});
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 403);
});

test("the customer queue exposes the restriction for the card to print", async () => {
  const { user, userPlan } = await setup({ planModels: ["a"], code: "k" });
  const card = getQueueSync(db, user.id).find((entry) => entry.id === userPlan.id);
  assert.deepEqual(card.allowedModels, ["a"]);

  // An unrestricted purchase carries null, and the card then says nothing about
  // models — the common case must not gain a new line.
  grantUserPlan(db, { userId: user.id, planId: null, source: "admin", creditNanoUsd: 1e10, durationDays: 30 });
  const open = getQueueSync(db, user.id).find((entry) => entry.allowedModels === null);
  assert.ok(open);
});
