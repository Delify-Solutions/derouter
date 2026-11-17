// A plan may cap how much of its shared credit pool a group of models can take
// (change plan-model-caps).
//
// What must hold, each one a way this feature can be wrong:
//   1. the pool stays shared: capped spend still drains the purchase's credit;
//   2. a full cap refuses THAT model only; other models keep paying from the pool;
//   3. another purchase of the account may pay when this one's cap is full;
//   4. a whole-term cap never reopens; a windowed one reopens when its window closes;
//   5. the counters equal what the ledger says (rebuildable);
//   6. the plan form's input is validated before anything is written.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dr-plan-caps-"));
process.env.DATA_DIR = dir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const { runMigrationOnce } = await import("../src/lib/db/migrate.js");
const { createPlan, updatePlan, getPlanById, expireStalePlans } = await import("../src/lib/db/repos/billingRepo.js");
const { deleteUser } = await import("../src/lib/db/repos/userRepo.js");
const { closeUserPlanSync } = await import("../src/lib/billing/grants.js");
const { createCombo } = await import("../src/lib/db/repos/combosRepo.js");
const { createUser } = await import("../src/lib/db/repos/userRepo.js");
const { createKeyGroup } = await import("../src/lib/db/repos/keyGroupsRepo.js");
const { grantUserPlan } = await import("../src/lib/billing/grants.js");
const { admitSync, chargeSync, listQueueSync, queueViewSync, rebuildCapSpendSync } = await import("../src/lib/billing/planQueue.js");
const caps = await import("../src/lib/billing/modelCaps.js");
const { createApiKey } = await import("../src/lib/db/repos/apiKeysRepo.js");
const { enforceKeyLimits } = await import("../src/lib/auth/keyEnforcement.js");
const { modelCapMessage } = await import("../src/lib/auth/platformError.js");

const db = await getAdapter();
await runMigrationOnce(db);

const USD = (n) => Math.round(n * 1e9);
const HOUR = 3600_000;
const T0 = Date.parse("2026-11-20T10:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

async function combo(name) {
  if (!db.get(`SELECT name FROM combos WHERE name = ?`, [name])) await createCombo({ name, models: [`test/${name}`] });
  return name;
}

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// A user holding one purchase of a $150 plan whose "img" cap is $15.
async function holder({ modelCaps, credit = 150, code = "cap" } = {}) {
  const suffix = Math.random().toString(36).slice(2, 8);
  await combo("img"); await combo("deepseek"); await combo("glm");
  const group = await createKeyGroup({ name: `g-${suffix}`, allowedModels: null });
  const user = await createUser({ email: `u-${suffix}@example.com`, passwordHash: "x", status: "active", groupId: group.id });
  const plan = await createPlan({
    code: `${code}_${suffix}`, name: "Goal", priceNanoUsd: 0, creditNanoUsd: USD(credit), durationDays: 30,
    modelCaps: modelCaps ?? [{ label: "Ảnh", models: ["img"], maxNanoUsd: USD(15), hours: null }],
  });
  const { userPlan } = grantUserPlan(db, {
    userId: user.id, planId: plan.id, source: "admin", creditNanoUsd: USD(credit), durationDays: 30,
  });
  return { user, plan, userPlan, group };
}

let n = 0;
const pay = (userId, model, usd, atMs = Date.now()) => chargeSync(db, {
  userId, costNanoUsd: USD(usd), requestKey: `req-${++n}-${Math.random()}`, model, nowIso: iso(atMs),
});
const credit = (userId, id) => listQueueSync(db, userId).find((e) => e.id === id).creditRemainingNanoUsd;

// ── the pure rules ─────────────────────────────────────────────────────────

test("normalize: ids are generated, only null hours mean the whole term, garbage throws", () => {
  const [cap] = caps.normalizeModelCaps([{ label: " Ảnh ", models: ["a", "a", " b "], max: 5 }], { makeId: () => "cap_x" });
  assert.deepEqual(cap, { id: "cap_x", label: "Ảnh", models: ["a", "b"], maxNanoUsd: 5, hours: null });
  assert.deepEqual(caps.normalizeModelCaps(null), []);
  assert.deepEqual(caps.normalizeModelCaps("[]"), []);
  assert.throws(() => caps.normalizeModelCaps({ not: "an array" }), TypeError);
  assert.throws(() => caps.normalizeModelCaps("{bad"), TypeError);
  // a corrupt stored value reads as "no caps" rather than throwing in the request path
  assert.deepEqual(caps.parseModelCaps("{bad"), []);
  assert.equal(caps.serializeModelCaps([]), null);
});

test("matching uses the allow-list matcher; a request without a model matches no cap", () => {
  const list = [{ id: "a", label: "A", models: ["claude-sonnet"], maxNanoUsd: 1, hours: null }];
  assert.equal(caps.capsForModel(list, "anthropic/claude-sonnet").length, 1);
  assert.equal(caps.capsForModel(list, "gpt-5").length, 0);
  assert.equal(caps.capsForModel(list, null).length, 0);
});

test("evaluateCap: whole-term never closes, windowed closes with its window", () => {
  const term = { id: "t", label: "T", models: ["m"], maxNanoUsd: 100, hours: null };
  const win = { id: "w", label: "W", models: ["m"], maxNanoUsd: 100, hours: 5 };
  const spend = { startedAt: iso(T0), spentNanoUsd: 100 };
  const t = caps.evaluateCap(term, spend, T0 + 1000 * HOUR);
  assert.equal(t.full, true);
  assert.equal(t.resetAt, null);
  const w = caps.evaluateCap(win, spend, T0 + 2 * HOUR);
  assert.equal(w.full, true);
  assert.equal(w.resetAt, iso(T0 + 5 * HOUR));
  const after = caps.evaluateCap(win, spend, T0 + 5 * HOUR);
  assert.equal(after.full, false);
  assert.equal(after.spentNanoUsd, 0);
  assert.equal(caps.evaluateCap(win, null, T0).roomNanoUsd, 100);
});

test("validation rules and their Vietnamese messages", () => {
  const ok = { label: "Ảnh", models: ["img"], maxNanoUsd: USD(15), hours: null };
  const rules = { kind: "llm", creditNanoUsd: USD(150), durationDays: 30 };
  assert.equal(caps.validateModelCaps([ok], rules), null);
  assert.match(caps.validateModelCaps([{ ...ok, label: "" }], rules), /cần một tên/);
  assert.match(caps.validateModelCaps([{ ...ok, models: [] }], rules), /ít nhất một model/);
  assert.match(caps.validateModelCaps([{ ...ok, maxNanoUsd: 0 }], rules), /lớn hơn 0/);
  assert.match(caps.validateModelCaps([{ ...ok, maxNanoUsd: USD(150) }], rules), /nhỏ hơn credit/);
  assert.match(caps.validateModelCaps([{ ...ok, hours: 24 * 31 }], rules), /chu kỳ/);
  // a mistyped window must be refused, never quietly turned into a whole-term cap
  assert.match(caps.validateModelCaps([{ ...ok, hours: 0 }], rules), /chu kỳ/);
  assert.match(caps.validateModelCaps([{ ...ok, hours: "" }], rules), /chu kỳ/);
  assert.match(caps.validateModelCaps([{ ...ok, hours: 1.5 }], rules), /chu kỳ/);
  assert.match(caps.validateModelCaps([{ ...ok, hours: "abc" }], rules), /chu kỳ/);
  assert.match(caps.validateModelCaps([ok], { ...rules, kind: " IMAGE " }), /Gói ảnh/);
  assert.match(caps.validateModelCaps([ok], { ...rules, kind: "image" }), /Gói ảnh/);
  assert.match(caps.validateModelCaps(Array.from({ length: 6 }, (_, i) => ({ ...ok, id: `c${i}` })), rules), /Tối đa 5/);
  assert.match(caps.validateModelCaps([{ ...ok, id: "x" }, { ...ok, id: "x" }], rules), /trùng/);
  // an unlimited-credit plan has no balance to compare against: the cap is the only bound
  assert.equal(caps.validateModelCaps([ok], { ...rules, unlimited: true, creditNanoUsd: 0 }), null);
  assert.equal(caps.describeModelCap({ ...ok }), "Ảnh: tối đa $15 cho cả thời hạn gói");
  assert.equal(caps.describeModelCap({ ...ok, hours: 5 }), "Ảnh: tối đa $15 mỗi 5 giờ");
});

// ── storage ────────────────────────────────────────────────────────────────

test("a plan stores its caps with generated ids; the form keeps ids on edit; null clears", async () => {
  await combo("img");
  const plan = await createPlan({
    code: `store_${Math.random().toString(36).slice(2, 7)}`, name: "S", priceNanoUsd: 0, creditNanoUsd: USD(100), durationDays: 30,
    modelCaps: [{ label: "Ảnh", models: ["img"], maxNanoUsd: USD(10), hours: null }],
  });
  assert.equal(plan.modelCaps.length, 1);
  const id = plan.modelCaps[0].id;
  assert.match(id, /^cap_[0-9a-f]{8}$/);
  // sending the cap back with its id keeps the id (its spend counters stay attached)
  const edited = await updatePlan(plan.id, { modelCaps: [{ ...plan.modelCaps[0], maxNanoUsd: USD(20) }] });
  assert.equal(edited.modelCaps[0].id, id);
  assert.equal(edited.modelCaps[0].maxNanoUsd, USD(20));
  assert.deepEqual((await getPlanById(plan.id)).modelCaps, edited.modelCaps);
  assert.deepEqual((await updatePlan(plan.id, { modelCaps: null })).modelCaps, []);
});

test("a cap naming a combo that does not exist is refused", async () => {
  await assert.rejects(() => createPlan({
    code: `bad_${Math.random().toString(36).slice(2, 7)}`, name: "B", priceNanoUsd: 0, creditNanoUsd: USD(100), durationDays: 30,
    modelCaps: [{ label: "X", models: ["no-such-combo"], maxNanoUsd: USD(5), hours: null }],
  }), /Model không tồn tại: no-such-combo/);
});

// ── the example: $150 pool, images capped at $15 ───────────────────────────

test("images stop at $15 while the rest of the pool keeps paying for the other models", async () => {
  const { user, userPlan } = await holder();
  assert.equal(admitSync(db, user.id, null, { model: "img" }).ok, true);

  pay(user.id, "img", 10);
  assert.equal(admitSync(db, user.id, null, { model: "img" }).ok, true, "$10 of $15 used");
  // The pool is shared: image spend drained the purchase's credit too.
  assert.equal(credit(user.id, userPlan.id), USD(140));

  // A $6 image request with $5 of cap room left: pass 1 takes $5, pass 2 the last $1
  // (an admitted request is always paid), after which the cap reads full.
  pay(user.id, "img", 6);
  assert.equal(credit(user.id, userPlan.id), USD(134));
  const full = admitSync(db, user.id, null, { model: "img" });
  assert.equal(full.ok, false);
  assert.equal(full.status, 429);
  assert.equal(full.code, "model_cap");
  assert.equal(full.capLabel, "Ảnh");
  assert.equal(full.resetAt, null, "a whole-term cap has no reopen time");
  assert.equal(full.retryAfterSec, undefined);

  // Other models are untouched and keep drawing on the same pool.
  assert.equal(admitSync(db, user.id, null, { model: "deepseek" }).ok, true);
  pay(user.id, "deepseek", 20);
  pay(user.id, "glm", 30);
  assert.equal(credit(user.id, userPlan.id), USD(84));
  assert.equal(admitSync(db, user.id, null, { model: "img" }).code, "model_cap", "still full");

  // The customer's queue shows the bar for the card.
  const card = queueViewSync(db, user.id).find((e) => e.id === userPlan.id);
  assert.equal(card.caps.length, 1);
  assert.equal(card.caps[0].spentNanoUsd, USD(16));
  assert.equal(card.caps[0].full, true);
});

test("a full cap is not the plan's window block: the purchase still pays other models", async () => {
  const { user, userPlan } = await holder({ credit: 100 });
  pay(user.id, "img", 15);
  const view = queueViewSync(db, user.id).find((e) => e.id === userPlan.id);
  assert.equal(view.blocked, false);
  assert.equal(view.eligible, true);
});

test("another purchase pays when this one's cap is full", async () => {
  const { user, userPlan } = await holder();
  pay(user.id, "img", 15);
  assert.equal(admitSync(db, user.id, null, { model: "img" }).code, "model_cap");

  // A second purchase without caps (an admin credit grant) joins the queue.
  const extra = grantUserPlan(db, { userId: user.id, planId: null, source: "admin", creditNanoUsd: USD(50), durationDays: 30 });
  const verdict = admitSync(db, user.id, null, { model: "img" });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.planId, extra.userPlan.id);

  const before = credit(user.id, userPlan.id);
  pay(user.id, "img", 4);
  assert.equal(credit(user.id, userPlan.id), before, "the capped purchase is not charged for images");
  assert.equal(credit(user.id, extra.userPlan.id), USD(46));
});

test("a window block wins over a cap that reopens; a permanent cap is reported as such", async () => {
  const { user, plan } = await holder({ credit: 100 });
  // one purchase carrying a $20 / 5 h window next to the $15 image cap
  const solo = await createUser({ email: `w-${Math.random().toString(36).slice(2, 8)}@example.com`, passwordHash: "x", status: "active", groupId: user.groupId });
  grantUserPlan(db, {
    userId: solo.id, planId: plan.id, source: "admin", creditNanoUsd: USD(100), durationDays: 30,
    limits: [{ hours: 5, maxNanoUsd: USD(20) }],
  });
  pay(solo.id, "img", 15, T0);
  // cap full, window ($15 of $20) not: only the cap refuses, and only images
  assert.equal(admitSync(db, solo.id, iso(T0 + HOUR), { model: "img" }).code, "model_cap");
  assert.equal(admitSync(db, solo.id, iso(T0 + HOUR), { model: "deepseek" }).ok, true);
  pay(solo.id, "deepseek", 5, T0 + HOUR);
  // now the window is full too. Another model is only waiting for the window ...
  const ds = admitSync(db, solo.id, iso(T0 + 2 * HOUR), { model: "deepseek" });
  assert.equal(ds.code, "plan_limit");
  assert.equal(ds.resetAt, iso(T0 + 5 * HOUR));
  // ... but images also hit a whole-term cap that never reopens, so no time is promised
  const img = admitSync(db, solo.id, iso(T0 + 2 * HOUR), { model: "img" });
  assert.equal(img.code, "model_cap");
  assert.equal(img.resetAt, null);
});

// ── a windowed cap ─────────────────────────────────────────────────────────

test("a windowed cap reopens when its window closes", async () => {
  const { user } = await holder({ modelCaps: [{ label: "Ảnh", models: ["img"], maxNanoUsd: USD(15), hours: 5 }] });
  pay(user.id, "img", 15, T0);
  const blocked = admitSync(db, user.id, iso(T0 + HOUR), { model: "img" });
  assert.equal(blocked.code, "model_cap");
  assert.equal(blocked.resetAt, iso(T0 + 5 * HOUR));
  assert.equal(blocked.retryAfterSec, 4 * 3600);
  assert.equal(admitSync(db, user.id, iso(T0 + HOUR), { model: "deepseek" }).ok, true);

  assert.equal(admitSync(db, user.id, iso(T0 + 5 * HOUR + 1000), { model: "img" }).ok, true);
  // the next charge opens a fresh window
  pay(user.id, "img", 3, T0 + 6 * HOUR);
  const view = queueViewSync(db, user.id, iso(T0 + 6 * HOUR)).find((e) => e.caps.length);
  assert.equal(view.caps[0].spentNanoUsd, USD(3));
  assert.equal(view.caps[0].resetAt, iso(T0 + 11 * HOUR));
});

test("a model listed in two caps counts in both and is refused by either", async () => {
  const { user } = await holder({
    modelCaps: [
      { id: "wide", label: "Media", models: ["img", "glm"], maxNanoUsd: USD(40), hours: null },
      { id: "narrow", label: "Ảnh", models: ["img"], maxNanoUsd: USD(10), hours: null },
    ],
  });
  pay(user.id, "img", 10);
  const queue = listQueueSync(db, user.id).find((e) => e.caps.length === 2);
  assert.equal(queue.capSpend.wide.spentNanoUsd, USD(10));
  assert.equal(queue.capSpend.narrow.spentNanoUsd, USD(10));
  assert.equal(admitSync(db, user.id, null, { model: "img" }).capLabel, "Ảnh");
  // glm only counts in the wide cap
  pay(user.id, "glm", 5);
  assert.equal(listQueueSync(db, user.id).find((e) => e.caps.length === 2).capSpend.wide.spentNanoUsd, USD(15));
});

// ── consistency with the ledger ────────────────────────────────────────────

test("the counters equal what the ledger replays", async () => {
  const { user, userPlan } = await holder({
    modelCaps: [
      { id: "term", label: "Ảnh", models: ["img"], maxNanoUsd: USD(15), hours: null },
      { id: "win", label: "GLM", models: ["glm"], maxNanoUsd: USD(30), hours: 5 },
    ],
  });
  pay(user.id, "img", 4, T0);
  pay(user.id, "glm", 7, T0 + HOUR);
  pay(user.id, "img", 3, T0 + 2 * HOUR);
  pay(user.id, "glm", 2, T0 + 7 * HOUR); // the 5 h window opened at T0+1h has closed
  pay(user.id, "deepseek", 9, T0 + 8 * HOUR); // matches no cap
  const live = Object.fromEntries(
    db.all(`SELECT capId, startedAt, spentNanoUsd FROM userPlanCapSpend WHERE userPlanId = ?`, [userPlan.id])
      .map((r) => [r.capId, { startedAt: r.startedAt, spentNanoUsd: r.spentNanoUsd }])
  );
  const rebuilt = rebuildCapSpendSync(db, userPlan.id, iso(T0 + 8 * HOUR));
  assert.deepEqual(rebuilt, live);
  assert.equal(live.term.spentNanoUsd, USD(7));
  assert.equal(live.win.spentNanoUsd, USD(2));
});

// ── enforcement ────────────────────────────────────────────────────────────

test("the API answers 429 model_cap with a message that says other models still work", async () => {
  const { user } = await holder();
  const key = await createApiKey("k", "test", { userId: user.id });
  pay(user.id, "img", 15);
  const denied = await enforceKeyLimits(key.key, "img", {});
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 429);
  assert.equal(denied.code, "model_cap");
  assert.match(denied.message, /"Ảnh"/);
  assert.match(denied.message, /model khác/);
  assert.equal(denied.retryAfterSec, undefined);
  assert.notEqual((await enforceKeyLimits(key.key, "deepseek", {})).code, "model_cap");
  assert.match(modelCapMessage("Ảnh", iso(Date.now() + 2 * HOUR)), /mở lại sau/);
});

test("revoking a purchase removes its cap counters", async () => {
  const { user, userPlan } = await holder();
  pay(user.id, "img", 2);
  assert.equal(db.all(`SELECT 1 FROM userPlanCapSpend WHERE userPlanId = ?`, [userPlan.id]).length, 1);
  const { revokePlanSync } = await import("../src/lib/billing/adminActions.js");
  const result = db.transaction(() => revokePlanSync(db, user.id, userPlan.id, { reason: "test revoke", actor: "test" }));
  assert.ok(result?.ok !== false, JSON.stringify(result));
  assert.equal(db.all(`SELECT 1 FROM userPlanCapSpend WHERE userPlanId = ?`, [userPlan.id]).length, 0);
});

// ── verdict when two blocks meet ───────────────────────────────────────────

test("a window block plus a whole-term cap never promises a reopen time", async () => {
  const { user, plan } = await holder({ credit: 100, modelCaps: [{ label: "Ảnh", models: ["img"], maxNanoUsd: USD(10), hours: null }] });
  const solo = await createUser({ email: `p-${Math.random().toString(36).slice(2, 8)}@example.com`, passwordHash: "x", status: "active", groupId: user.groupId });
  grantUserPlan(db, {
    userId: solo.id, planId: plan.id, source: "admin", creditNanoUsd: USD(100), durationDays: 30,
    limits: [{ hours: 5, maxNanoUsd: USD(20) }],
  });
  pay(solo.id, "img", 10, T0);       // whole-term cap used up
  pay(solo.id, "deepseek", 10, T0);  // and the 5 h window ($20) too
  // images: waiting for the window would not help, the cap never reopens
  const img = admitSync(db, solo.id, iso(T0 + HOUR), { model: "img" });
  assert.equal(img.code, "model_cap");
  assert.equal(img.resetAt, null);
  // another model is only waiting for the window
  const ds = admitSync(db, solo.id, iso(T0 + HOUR), { model: "deepseek" });
  assert.equal(ds.code, "plan_limit");
  assert.equal(ds.resetAt, iso(T0 + 5 * HOUR));
});

test("window and windowed cap both block: the reopen time is the later one", async () => {
  const { user, plan } = await holder({ credit: 100, modelCaps: [{ label: "Ảnh", models: ["img"], maxNanoUsd: USD(10), hours: 24 }] });
  const solo = await createUser({ email: `q-${Math.random().toString(36).slice(2, 8)}@example.com`, passwordHash: "x", status: "active", groupId: user.groupId });
  grantUserPlan(db, {
    userId: solo.id, planId: plan.id, source: "admin", creditNanoUsd: USD(100), durationDays: 30,
    limits: [{ hours: 5, maxNanoUsd: USD(20) }],
  });
  pay(solo.id, "img", 10, T0);
  pay(solo.id, "deepseek", 10, T0);
  const verdict = admitSync(db, solo.id, iso(T0 + HOUR), { model: "img" });
  // the window reopens at +5h but the 24 h cap only at +24h: waiting 5h would not be enough
  assert.equal(verdict.resetAt, iso(T0 + 24 * HOUR));
});

// ── which purchases have caps ──────────────────────────────────────────────

test("an unlimited-credit plan enforces its cap: the cap is the only bound on that group", async () => {
  await combo("img"); await combo("deepseek");
  const suffix = Math.random().toString(36).slice(2, 8);
  const group = await createKeyGroup({ name: `g-${suffix}`, allowedModels: null });
  const user = await createUser({ email: `n-${suffix}@example.com`, passwordHash: "x", status: "active", groupId: group.id });
  const plan = await createPlan({
    code: `unl_${suffix}`, name: "Unlimited", priceNanoUsd: 0, unlimitedCredit: true, durationDays: 30,
    limits: [{ hours: 24, maxNanoUsd: USD(100) }],
    modelCaps: [{ label: "Ảnh", models: ["img"], maxNanoUsd: USD(5), hours: null }],
  });
  grantUserPlan(db, { userId: user.id, planId: plan.id, source: "admin", creditNanoUsd: 0, unlimitedCredit: true, durationDays: 30,
    limits: [{ hours: 24, maxNanoUsd: USD(100) }] });
  pay(user.id, "img", 5);
  assert.equal(admitSync(db, user.id, null, { model: "img" }).code, "model_cap");
  assert.equal(admitSync(db, user.id, null, { model: "deepseek" }).ok, true);
});

test("a purchase without a plan (gift, admin grant) has no caps", async () => {
  const { user } = await holder();
  const solo = await createUser({ email: `g-${Math.random().toString(36).slice(2, 8)}@example.com`, passwordHash: "x", status: "active", groupId: user.groupId });
  const { userPlan } = grantUserPlan(db, { userId: solo.id, planId: null, source: "admin", creditNanoUsd: USD(100), durationDays: 30 });
  pay(solo.id, "img", 60);
  assert.equal(admitSync(db, solo.id, null, { model: "img" }).ok, true);
  assert.equal(listQueueSync(db, solo.id).find((e) => e.id === userPlan.id).caps.length, 0);
});

test("an image-count plan refuses caps, whatever the case of its kind", async () => {
  await combo("img");
  for (const kind of ["image", "IMAGE", " Image "]) {
    await assert.rejects(() => createPlan({
      code: `im_${Math.random().toString(36).slice(2, 8)}`, name: "I", priceNanoUsd: 0, kind, imageCount: 10, durationDays: 30,
      modelCaps: [{ label: "Ảnh", models: ["img"], maxNanoUsd: USD(5), hours: null }],
    }), /Gói ảnh/, kind);
  }
});

// ── every way a purchase's counters can end ────────────────────────────────

const capRows = (id) => db.all(`SELECT 1 FROM userPlanCapSpend WHERE userPlanId = ?`, [id]).length;

test("expiry, closing a purchase and deleting the user all remove cap counters", async () => {
  const a = await holder();
  pay(a.user.id, "img", 2);
  assert.equal(capRows(a.userPlan.id), 1);
  db.transaction(() => expireStalePlans(db, iso(Date.now() + 40 * 24 * HOUR)));
  assert.equal(capRows(a.userPlan.id), 0, "expired purchase");

  const b = await holder();
  pay(b.user.id, "img", 2);
  const purchase = db.get(`SELECT * FROM userPlans WHERE id = ?`, [b.userPlan.id]);
  db.transaction(() => closeUserPlanSync(db, purchase, { status: "revoked", reason: "test" }));
  assert.equal(capRows(b.userPlan.id), 0, "closed purchase");

  const c = await holder();
  pay(c.user.id, "img", 2);
  assert.equal(capRows(c.userPlan.id), 1);
  await deleteUser(c.user.id, { actor: "test" });
  assert.equal(capRows(c.userPlan.id), 0, "deleted user");
});
