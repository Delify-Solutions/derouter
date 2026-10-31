// Time-limited model discounts (spec model-discounts).
//
// Pure rule logic (matching, stacking, cap, rounding, validation) runs against a
// throwaway SQLite DB through the driver-free engine; two end-to-end cases drive
// saveRequestUsage to prove the usage row, the charge and the ledger agree.
// `now` is always passed explicitly — no clock mocking.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-discounts-test-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const d = await import("../src/lib/billing/discounts.js");
const queue = await import("../src/lib/billing/planQueue.js");
const usage = await import("../src/lib/db/repos/usageRepo.js");
const { updateComboPricing } = await import("../src/lib/db/repos/comboPricingRepo.js");
const { NANO } = await import("../src/shared/utils/money.js");

let db;
const USD = (n) => Math.round(n * NANO);
const T0 = Date.UTC(2026, 9, 29, 10, 0, 0);
const at = (ms) => new Date(ms).toISOString();
const HOUR = 3600_000;
const DAY = 24 * HOUR;

before(async () => { db = await getAdapter(); });

after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  for (const table of [
    "modelDiscounts", "userPlanWindows", "creditLedger", "userPlans", "plans", "apiKeys",
    "users", "usageHistory", "combos", "keyGroups", "kv", "userAuditLog",
  ]) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* partial schema */ }
  }
});

// ── Fixtures ────────────────────────────────────────────────────────────────

function combo(name) {
  db.run(
    `INSERT INTO combos(id, name, kind, models, meta, createdAt, updatedAt) VALUES(?, ?, 'llm', '[]', '{}', ?, ?)`,
    [`c-${name}`, name, at(T0), at(T0)]
  );
}
function group(id, { active = 1 } = {}) {
  db.run(`INSERT INTO keyGroups(id, name, isActive, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?)`, [id, id, active, at(T0), at(T0)]);
}
function plan(id) {
  db.run(
    `INSERT INTO plans(id, code, name, priceNanoUsd, creditNanoUsd, durationDays, isActive, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, 30, 1, ?, ?)`,
    [id, id, id, USD(10), USD(100), at(T0), at(T0)]
  );
}
function user(id = "u1", groupId = null) {
  db.run(
    `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
     VALUES(?, ?, 'x', NULL, ?, 'active', 0, ?, ?)`,
    [id, `${id}@test.local`, groupId, at(T0), at(T0)]
  );
}
function purchase(id, { userId = "u1", planId = null, creditUsd = 100, limits = null, priority = null } = {}) {
  db.run(
    `INSERT INTO userPlans(id, userId, planId, orderId, source, creditTotalNanoUsd, creditRemainingNanoUsd, startsAt, expiresAt, status, priority, limits, createdAt)
     VALUES(?, ?, ?, NULL, 'admin', ?, ?, ?, ?, 'active', ?, ?, ?)`,
    [id, userId, planId, USD(creditUsd), USD(creditUsd), at(T0), at(T0 + 30 * DAY), priority, limits ? JSON.stringify(limits) : null, at(T0)]
  );
}
function key(id = "k1", userId = "u1") {
  db.run(`INSERT INTO apiKeys(id, key, name, isActive, createdAt, userId) VALUES(?, ?, ?, 1, ?, ?)`, [id, `secret-${id}`, id, at(T0), userId]);
}

/** Create a rule and fail loudly if validation refuses it. */
function rule(input) {
  const out = d.createDiscountSync(db, { startsAt: null, endsAt: null, ...input }, { now: at(T0) });
  assert.equal(out.ok, true, JSON.stringify(out.errors));
  return out.rule;
}

const find = (extra = {}) => d.resolveDiscountSync(db, { at: at(T0), ...extra });

// ── Percent, rounding, cap ──────────────────────────────────────────────────

test("percent parses to integer basis points with no float math", () => {
  assert.equal(d.parsePercentToBp("12.5"), 1250);
  assert.equal(d.parsePercentToBp("12,5"), 1250);
  assert.equal(d.parsePercentToBp(0.07), 7);
  assert.equal(d.parsePercentToBp("0.01"), 1);
  assert.equal(d.parsePercentToBp("100"), 10000);
  assert.equal(d.parsePercentToBp("100.00"), 10000);
  for (const bad of ["0", "0.00", "0.001", "100.01", "101", "-5", "abc", "", null, undefined, true, "1e2"]) {
    assert.equal(d.parsePercentToBp(bad), null, `rejects ${String(bad)}`);
  }
  assert.equal(d.formatBp(1250), "12.5");
  assert.equal(d.formatBp(10000), "100");
  assert.equal(d.formatBp(1), "0.01");
});

test("applyBp rounds half up to a whole nanoUSD and never leaves [0, list]", () => {
  assert.equal(d.applyBp(1000, 0), 1000);
  assert.equal(d.applyBp(1000, 2500), 750);
  assert.equal(d.applyBp(1000, 10000), 0, "100% is free");
  assert.equal(d.applyBp(0, 5000), 0);
  // 3 × 0.5 = 1.5 → 2 (half up); 1 × 0.5 = 0.5 → 1.
  assert.equal(d.applyBp(3, 5000), 2);
  assert.equal(d.applyBp(1, 5000), 1);
  // 10 × 0.3333 = 3.333 → 3 ; 10 × 0.0001 off = 9.999 → 10.
  assert.equal(d.applyBp(10, 6667), 3);
  assert.equal(d.applyBp(10, 1), 10);
  // Huge costs stay exact (BigInt): 9e15 × 0.5.
  assert.equal(d.applyBp(9_000_000_000_000_000, 5000), 4_500_000_000_000_000);
  for (const bp of [0, 1, 4999, 5000, 9999, 10000, 20000]) {
    const out = d.applyBp(123_456_789, bp);
    assert.ok(Number.isInteger(out) && out >= 0 && out <= 123_456_789);
  }
});

test("stacking is additive and capped at 100% (60% + 70% -> 100%)", () => {
  assert.deepEqual(d.combineBp([1000, 2500]), { rawBp: 3500, totalBp: 3500, capped: false });
  assert.deepEqual(d.combineBp([6000, 7000]), { rawBp: 13000, totalBp: 10000, capped: true });
  assert.deepEqual(d.combineBp([]), { rawBp: 0, totalBp: 0, capped: false });
  assert.equal(d.applyBp(USD(1), d.combineBp([6000, 7000]).totalBp), 0);
});

// ── Window ─────────────────────────────────────────────────────────────────

test("window: startsAt inclusive, endsAt exclusive, open ends allowed", () => {
  combo("gpt");
  const r = rule({ scopeType: "combo", scopeId: "gpt", percent: "10", startsAt: at(T0), endsAt: at(T0 + HOUR) });
  const at_ = (ms) => d.resolveDiscountSync(db, { at: at(ms), requestedModel: "gpt" }).totalBp;
  assert.equal(at_(T0 - 1), 0, "just before start");
  assert.equal(at_(T0), 1000, "exactly at start: inclusive");
  assert.equal(at_(T0 + HOUR - 1), 1000);
  assert.equal(at_(T0 + HOUR), 0, "exactly at end: exclusive");
  assert.equal(d.ruleStatus(r, T0 - 1), "upcoming");
  assert.equal(d.ruleStatus(r, T0), "active");
  assert.equal(d.ruleStatus(r, T0 + HOUR), "expired");

  const open = rule({ scopeType: "combo", scopeId: "gpt", percent: "5" });
  assert.equal(at_(T0 + 400 * DAY), 500, "a rule with no bounds never ends");
  assert.equal(d.ruleStatus({ ...open, isActive: false }, T0), "disabled");
});

test("inactive and expired rules are ignored", () => {
  combo("gpt");
  const off = rule({ scopeType: "combo", scopeId: "gpt", percent: "10", isActive: false });
  rule({ scopeType: "combo", scopeId: "gpt", percent: "20", endsAt: at(T0 - HOUR), startsAt: at(T0 - 2 * HOUR) });
  assert.equal(find({ requestedModel: "gpt" }).totalBp, 0);
  d.updateDiscountSync(db, off.id, { isActive: true });
  assert.equal(find({ requestedModel: "gpt" }).totalBp, 1000, "re-enabled rule applies");
});

// ── Scope ──────────────────────────────────────────────────────────────────

test("combo scope matches only the bare combo name", () => {
  combo("gpt"); combo("other");
  rule({ scopeType: "combo", scopeId: "gpt", percent: "10" });
  assert.equal(find({ requestedModel: "gpt" }).totalBp, 1000);
  assert.equal(find({ requestedModel: "other" }).totalBp, 0);
  assert.equal(find({ requestedModel: "openai/gpt" }).totalBp, 0, "provider/model never matches a combo rule");
  assert.equal(find({ requestedModel: null }).totalBp, 0);
});

test("group scope: the customer's active group, optionally limited to some models", () => {
  combo("a"); combo("b"); group("g1"); group("g2"); group("gOff", { active: 0 });
  user("u1", "g1"); user("u2", "g2"); user("u3", "gOff");
  rule({ scopeType: "group", scopeId: "g1", percent: "10" }); // all models
  rule({ scopeType: "group", scopeId: "g1", percent: "5", models: ["a"] });
  rule({ scopeType: "group", scopeId: "gOff", percent: "50" });

  assert.equal(find({ userId: "u1", requestedModel: "a" }).totalBp, 1500, "both g1 rules cover a");
  assert.equal(find({ userId: "u1", requestedModel: "b" }).totalBp, 1000, "only the all-models rule covers b");
  assert.equal(find({ userId: "u2", requestedModel: "a" }).totalBp, 0, "another group is not discounted");
  assert.equal(find({ userId: "u3", requestedModel: "a" }).totalBp, 0, "an inactive group is as good as absent");
  assert.equal(find({ requestedModel: "a" }).totalBp, 0, "no customer, no group rules");
  assert.equal(find({ groupId: "g1", planId: null, requestedModel: "b" }).totalBp, 1000, "explicit group for display surfaces");
});

test("plan scope: the plan template that pays first", () => {
  combo("a"); plan("pro"); plan("lite"); user("u1");
  rule({ scopeType: "plan", scopeId: "pro", percent: "20" });
  rule({ scopeType: "plan", scopeId: "lite", percent: "40", models: ["a"] });

  // Queue: lite first (priority 1), pro second.
  purchase("up-lite", { planId: "lite", priority: 1 });
  purchase("up-pro", { planId: "pro", priority: 2 });
  assert.equal(find({ userId: "u1", requestedModel: "a" }).totalBp, 4000, "lite pays first");
  assert.equal(find({ userId: "u1", requestedModel: "zzz" }).totalBp, 0, "lite's rule is limited to model a");

  // Fill lite's window: it is blocked, so pro pays.
  db.run(`UPDATE userPlans SET limits = ? WHERE id = 'up-lite'`, [JSON.stringify([{ hours: 5, maxNanoUsd: USD(1) }])]);
  queue.chargeSync(db, { userId: "u1", requestKey: "seed", costNanoUsd: USD(1), nowIso: at(T0) });
  assert.equal(find({ userId: "u1", requestedModel: "a" }).totalBp, 2000, "blocked plan is skipped; pro's rules apply");

  // Gift/grant purchases without a template carry no plan rules.
  db.run(`DELETE FROM userPlans`);
  purchase("up-gift", { planId: null });
  assert.equal(find({ userId: "u1", requestedModel: "a" }).totalBp, 0);
});

test("combo + group + plan rules stack additively across scopes and cap at 100%", () => {
  combo("a"); group("g1"); plan("pro"); user("u1", "g1"); purchase("up", { planId: "pro" });
  rule({ scopeType: "combo", scopeId: "a", percent: "30" });
  rule({ scopeType: "group", scopeId: "g1", percent: "25" });
  rule({ scopeType: "plan", scopeId: "pro", percent: "15.5" });
  const r = find({ userId: "u1", requestedModel: "a" });
  assert.equal(r.rawBp, 7050);
  assert.equal(r.totalBp, 7050);
  assert.equal(r.rules.length, 3);

  rule({ scopeType: "combo", scopeId: "a", percent: "60" });
  const capped = find({ userId: "u1", requestedModel: "a" });
  assert.equal(capped.rawBp, 13050);
  assert.equal(capped.totalBp, 10000);
  assert.equal(capped.capped, true);
});

test("resolve reports the earliest end among the applied rules", () => {
  combo("a");
  rule({ scopeType: "combo", scopeId: "a", percent: "10", endsAt: at(T0 + 5 * HOUR) });
  rule({ scopeType: "combo", scopeId: "a", percent: "10", endsAt: at(T0 + 2 * HOUR) });
  rule({ scopeType: "combo", scopeId: "a", percent: "10" });
  assert.equal(find({ requestedModel: "a" }).endsAt, at(T0 + 2 * HOUR));
});

test("pricing display: discounted rates are the list rates x (1 - total)", () => {
  const p = d.applyBpToPricing({ input: 3, output: 15, cached: 0.3, reasoning: 0 }, 2000);
  assert.deepEqual(p, { input: 2.4, output: 12, cached: 0.24, reasoning: 0 });
  assert.equal(d.applyBpToPricing({ input: 3 }, 10000).input, 0);
});

// ── Overlap warning ────────────────────────────────────────────────────────

test("analyzeOverlap warns on overlaps that exceed 100%, now or later, per model", () => {
  const mk = (over) => ({ isActive: true, startsAt: null, endsAt: null, models: null, ...over });
  const a = d.analyzeOverlap([mk({ percentBp: 6000 }), mk({ percentBp: 5000 })], T0);
  assert.deepEqual([a.nowRawBp, a.nowTotalBp, a.nowCapped], [11000, 10000, true]);

  // Different models do not stack with each other.
  const b = d.analyzeOverlap([mk({ percentBp: 6000, models: ["x"] }), mk({ percentBp: 6000, models: ["y"] })], T0);
  assert.equal(b.nowRawBp, 6000);
  assert.equal(b.peakCapped, false);

  // An all-models rule does stack with a model-specific one.
  const c = d.analyzeOverlap([mk({ percentBp: 6000, models: ["x"] }), mk({ percentBp: 5000 })], T0);
  assert.equal(c.nowRawBp, 11000);

  // An overlap that only starts in the future is flagged as the peak.
  const e = d.analyzeOverlap([mk({ percentBp: 6000 }), mk({ percentBp: 6000, startsAt: at(T0 + DAY) })], T0);
  assert.equal(e.nowCapped, false);
  assert.equal(e.peakCapped, true);

  // Expired / disabled rules are ignored.
  const f = d.analyzeOverlap([mk({ percentBp: 6000 }), mk({ percentBp: 6000, isActive: false }), mk({ percentBp: 6000, endsAt: at(T0 - 1) })], T0);
  assert.equal(f.nowRawBp, 6000);
});

// ── Validation ─────────────────────────────────────────────────────────────

test("validation: percent range, endsAt after startsAt, scope exists, models exist", () => {
  combo("a"); group("g1");
  const fields = (input) => {
    const out = d.createDiscountSync(db, input);
    return out.ok ? "ok" : out.errors.map((e) => e.field).sort().join(",");
  };
  const base = { scopeType: "combo", scopeId: "a", percent: "10" };
  assert.equal(fields(base), "ok");
  assert.equal(fields({ ...base, percent: "0" }), "percent");
  assert.equal(fields({ ...base, percent: "100.01" }), "percent");
  assert.equal(fields({ ...base, percent: "1.234" }), "percent");
  assert.equal(fields({ ...base, percent: undefined }), "percent");
  assert.equal(fields({ ...base, startsAt: at(T0), endsAt: at(T0) }), "endsAt", "equal bounds are an empty window");
  assert.equal(fields({ ...base, startsAt: at(T0), endsAt: at(T0 - 1) }), "endsAt");
  assert.equal(fields({ ...base, startsAt: "not a date" }), "startsAt");
  assert.equal(fields({ ...base, scopeId: "ghost" }), "scopeId");
  assert.equal(fields({ ...base, scopeType: "nope" }), "scopeType");
  assert.equal(fields({ scopeType: "group", scopeId: "ghost", percent: "5" }), "scopeId");
  assert.equal(fields({ scopeType: "plan", scopeId: "ghost", percent: "5" }), "scopeId");
  assert.equal(fields({ scopeType: "group", scopeId: "g1", percent: "5", models: ["ghost"] }), "models");
  assert.equal(fields({ scopeType: "group", scopeId: "g1", percent: "5", models: ["a"] }), "ok");
  assert.equal(fields({ ...base, models: ["a"] }), "models", "combo scope takes no model list");
  assert.equal(fields({ ...base, label: "x".repeat(81) }), "label");

  // Nothing was written by the refused attempts.
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM modelDiscounts`).n, 2);
});

test("update validates the merged rule and cannot move the scope", () => {
  combo("a"); combo("b");
  const r = rule({ scopeType: "combo", scopeId: "a", percent: "10", startsAt: at(T0), endsAt: at(T0 + HOUR) });
  assert.equal(d.updateDiscountSync(db, r.id, { endsAt: at(T0 - HOUR) }).ok, false, "end before the stored start");
  assert.equal(d.updateDiscountSync(db, "missing", { percent: "5" }).notFound, true);
  const moved = d.updateDiscountSync(db, r.id, { scopeId: "b", percent: "12.5" });
  assert.equal(moved.ok, true);
  assert.equal(moved.rule.scopeId, "a", "scope is fixed");
  assert.equal(moved.rule.percentBp, 1250);
  assert.equal(d.deleteDiscountSync(db, r.id), true);
  assert.equal(d.deleteDiscountSync(db, r.id), false);
});

test("renaming or deleting a combo keeps its rules coherent", () => {
  combo("a"); combo("b"); group("g1");
  rule({ scopeType: "combo", scopeId: "a", percent: "10" });
  const both = rule({ scopeType: "group", scopeId: "g1", percent: "5", models: ["a", "b"] });
  const onlyA = rule({ scopeType: "group", scopeId: "g1", percent: "7", models: ["a"] });

  d.renameComboInDiscountsSync(db, "a", "a2");
  assert.equal(d.listDiscountsSync(db, { scopeType: "combo" })[0].scopeId, "a2");
  assert.deepEqual(d.getDiscountSync(db, both.id).models, ["a2", "b"]);

  d.removeComboFromDiscountsSync(db, "a2");
  assert.equal(d.listDiscountsSync(db, { scopeType: "combo" }).length, 0);
  assert.deepEqual(d.getDiscountSync(db, both.id).models, ["b"]);
  const emptied = d.getDiscountSync(db, onlyA.id);
  assert.equal(emptied.isActive, false, "a rule left with no model is switched off, not widened to all models");
});

// ── End to end: usage row, charge and ledger agree ─────────────────────────

test("a charge through the plan queue uses the discounted cost, and the meta keeps the list cost", async () => {
  // Combo price $1 in / $2 out per 1M: 1,000 in + 500 out = $0.002 list.
  await updateComboPricing({ mycombo: { input: 1, output: 2 } });
  combo("mycombo"); group("g1"); plan("pro"); user("u1", "g1"); key("k1", "u1");
  purchase("up1", { planId: "pro", creditUsd: 10, limits: [{ hours: 5, maxNanoUsd: USD(20) }] });
  const r1 = rule({ scopeType: "combo", scopeId: "mycombo", percent: "25" });
  const r2 = rule({ scopeType: "group", scopeId: "g1", percent: "25" });
  const r3 = rule({ scopeType: "plan", scopeId: "pro", percent: "10", endsAt: at(Date.now() - 1000), startsAt: at(Date.now() - 2000) });

  const entry = {
    timestamp: new Date().toISOString(), provider: "testprov", model: "testmodel", apiKey: "secret-k1",
    requestedModel: "mycombo", tokens: { prompt_tokens: 1000, completion_tokens: 500 }, status: "ok",
  };
  await usage.saveRequestUsage({ ...entry });

  const row = db.get(`SELECT * FROM usageHistory ORDER BY id DESC LIMIT 1`);
  const meta = JSON.parse(row.meta);
  assert.equal(meta.listCostNanoUsd, USD(0.002));
  assert.equal(meta.discountBp, 5000, "25% + 25%; the expired plan rule is ignored");
  assert.deepEqual(meta.discountRuleIds.sort(), [r1.id, r2.id].sort());
  assert.ok(!meta.discountRuleIds.includes(r3.id));
  assert.equal(row.costNanoUsd, USD(0.001), "usage history stores the discounted cost");
  assert.equal(row.cost, 0.001);

  const ledger = db.all(`SELECT * FROM creditLedger WHERE kind = 'charge'`);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].deltaNanoUsd, -USD(0.001), "the ledger charges the discounted cost");
  assert.equal(db.get(`SELECT creditRemainingNanoUsd AS c FROM userPlans WHERE id = 'up1'`).c, USD(10) - USD(0.001));
  assert.equal(db.get(`SELECT spentNanoUsd AS s FROM userPlanWindows WHERE userPlanId = 'up1' AND hours = 5`).s, USD(0.001),
    "plan windows count the discounted spend");
});

test("100% off charges nothing and writes no ledger row", async () => {
  await updateComboPricing({ freecombo: { input: 1, output: 2 } });
  combo("freecombo"); user("u1"); key("k1", "u1"); purchase("up1", { creditUsd: 10 });
  rule({ scopeType: "combo", scopeId: "freecombo", percent: "60" });
  rule({ scopeType: "combo", scopeId: "freecombo", percent: "70" });

  await usage.saveRequestUsage({
    timestamp: new Date().toISOString(), provider: "testprov", model: "testmodel", apiKey: "secret-k1",
    requestedModel: "freecombo", tokens: { prompt_tokens: 1000, completion_tokens: 500 }, status: "ok",
  });
  const row = db.get(`SELECT * FROM usageHistory ORDER BY id DESC LIMIT 1`);
  assert.equal(row.costNanoUsd, 0);
  assert.equal(JSON.parse(row.meta).discountBp, 10000);
  assert.equal(JSON.parse(row.meta).listCostNanoUsd, USD(0.002));
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM creditLedger WHERE kind = 'charge'`).n, 0);
  assert.equal(db.get(`SELECT creditRemainingNanoUsd AS c FROM userPlans WHERE id = 'up1'`).c, USD(10));
});

test("a request with no matching rule is charged the list price and its meta stays clean", async () => {
  await updateComboPricing({ plain: { input: 1, output: 2 } });
  combo("plain"); combo("other"); user("u1"); key("k1", "u1"); purchase("up1", { creditUsd: 10 });
  rule({ scopeType: "combo", scopeId: "other", percent: "50" });
  await usage.saveRequestUsage({
    timestamp: new Date().toISOString(), provider: "testprov", model: "testmodel", apiKey: "secret-k1",
    requestedModel: "plain", tokens: { prompt_tokens: 1000, completion_tokens: 500 }, status: "ok",
  });
  const row = db.get(`SELECT * FROM usageHistory ORDER BY id DESC LIMIT 1`);
  assert.equal(row.costNanoUsd, USD(0.002));
  assert.equal(JSON.parse(row.meta).discountBp, undefined);
});

test("a live plan rule discounts the charge of the plan that pays", async () => {
  await updateComboPricing({ planned: { input: 1, output: 2 } });
  combo("planned"); plan("pro"); user("u1"); key("k1", "u1"); purchase("up1", { planId: "pro", creditUsd: 10 });
  const r = rule({ scopeType: "plan", scopeId: "pro", percent: "40" });
  await usage.saveRequestUsage({
    timestamp: new Date().toISOString(), provider: "testprov", model: "testmodel", apiKey: "secret-k1",
    requestedModel: "planned", tokens: { prompt_tokens: 1000, completion_tokens: 500 }, status: "ok",
  });
  const row = db.get(`SELECT * FROM usageHistory ORDER BY id DESC LIMIT 1`);
  assert.equal(row.costNanoUsd, USD(0.0012));
  assert.deepEqual(JSON.parse(row.meta).discountRuleIds, [r.id]);
  assert.equal(db.get(`SELECT deltaNanoUsd AS d FROM creditLedger WHERE kind = 'charge'`).d, -USD(0.0012));
});
