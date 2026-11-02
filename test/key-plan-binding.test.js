// Keys pinned to a plan (spec api-access-enforcement "Customer keys may be pinned to
// one plan"): a pinned key is paid by that plan alone, and RPM/TPM are counted per
// (user, plan) so that minting more keys never opens a second allowance.
//
// Rows are seeded by direct SQL against a throwaway SQLite database; only relative
// imports are used because plain `node --test` cannot resolve the `@/` alias.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-keyplan-test-"));
process.env.DATA_DIR = tmpDir;
// Never wait for TPM room: these tests assert the deny path.
process.env.TPM_MAX_WAIT_MS = "0";

const { getAdapter } = await import("../src/lib/db/driver.js");
const { enforceKeyLimits } = await import("../src/lib/auth/keyEnforcement.js");
const { admitSync, chargeSync, ratePlanIdSync } = await import("../src/lib/billing/planQueue.js");
const { applyRequestDiscountSync, createDiscountSync } = await import("../src/lib/billing/discounts.js");
const { saveRequestUsage } = await import("../src/lib/db/repos/usageRepo.js");
const { updateApiKey, getApiKeyById } = await import("../src/lib/db/repos/apiKeysRepo.js");
const { listBindablePlansSync, resolveKeyPlanInputSync } = await import("../src/lib/db/repos/accountPlansRepo.js");
const { NANO } = await import("../src/shared/utils/money.js");

let db;
const USD = (n) => Math.round(n * NANO);
const NOW = () => new Date().toISOString();
const inDays = (d) => new Date(Date.now() + d * 86_400_000).toISOString();
const secondsAgo = (s) => new Date(Date.now() - s * 1000).toISOString();

before(async () => { db = await getAdapter(); });

after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  for (const table of ["usageHistory", "creditLedger", "userPlanWindows", "userPlans", "apiKeys", "users", "keyGroups", "plans"]) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* table may not exist */ }
  }
});

// ── Fixtures ────────────────────────────────────────────────────────────────

function group() {
  const now = NOW();
  db.run(
    `INSERT INTO keyGroups(id, name, isActive, rpm, tpm, budgetUsd, resetWindow, allowedModels, priceOverrides, createdAt, updatedAt)
     VALUES('g', 'g', 1, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    [now, now]
  );
}

function user(id = "u1") {
  const now = NOW();
  db.run(
    `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
     VALUES(?, ?, 'x', NULL, 'g', 'active', 0, ?, ?)`,
    [id, `${id}@test.local`, now, now]
  );
}

function key(id, { userId = "u1", planId = null } = {}) {
  const now = NOW();
  const secret = `secret-${id}`;
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, updatedAt, userId, keyHash, keyPrefix, planId)
     VALUES(?, ?, ?, NULL, 1, ?, ?, ?, NULL, ?, ?)`,
    [id, secret, id, now, now, userId, secret.slice(0, 8), planId]
  );
  return secret;
}

function plan(id, { rpm = null, tpm = null } = {}) {
  const now = NOW();
  db.run(
    `INSERT INTO plans(id, code, name, priceNanoUsd, creditNanoUsd, durationDays, isActive, rpm, tpm, createdAt, updatedAt)
     VALUES(?, ?, ?, 0, ?, 30, 1, ?, ?, ?, ?)`,
    [id, id, `Plan ${id}`, USD(100), rpm, tpm, now, now]
  );
}

function grant(planId, { userId = "u1", usd = 10, priority = null, expiresAt = inDays(30) } = {}) {
  const now = NOW();
  const id = `up-${planId}-${Math.random().toString(36).slice(2)}`;
  db.run(
    `INSERT INTO userPlans(id, userId, planId, orderId, source, creditTotalNanoUsd, creditRemainingNanoUsd, startsAt, expiresAt, status, priority, createdAt)
     VALUES(?, ?, ?, NULL, 'purchase', ?, ?, ?, ?, 'active', ?, ?)`,
    [id, userId, planId, USD(usd), USD(usd), now, expiresAt, priority, now]
  );
  return id;
}

function usageRow(apiKeyId, ratePlanId, { at = secondsAgo(5), prompt = 10, completion = 10 } = {}) {
  db.run(
    `INSERT INTO usageHistory(timestamp, provider, model, apiKeyId, promptTokens, completionTokens, costNanoUsd, status, meta, ratePlanId)
     VALUES(?, 'test', 'model-a', ?, ?, ?, 0, 'ok', '{}', ?)`,
    [at, apiKeyId, prompt, completion, ratePlanId]
  );
}

// ── Admission and charging ──────────────────────────────────────────────────

test("a pinned key is admitted by its own plan, not the head of the queue", () => {
  plan("A"); plan("B");
  user();
  const upA = grant("A", { priority: 1 });
  const upB = grant("B", { priority: 2 });

  assert.equal(admitSync(db, "u1").planId, upA, "an unpinned request is paid by the head");
  assert.equal(admitSync(db, "u1", null, { planId: "B" }).planId, upB, "a key pinned to B is paid by B");
});

test("a pinned key never falls back to another plan", async () => {
  group(); plan("A"); plan("B");
  user();
  grant("A"); // the user holds A only
  const secret = key("kb", { planId: "B" });

  const result = await enforceKeyLimits(secret, "model-a");
  assert.equal(result.ok, false);
  assert.equal(result.status, 402);
  assert.equal(result.code, "insufficient_quota");
  assert.match(result.message, /Plan B/, "the message names the plan the key waits for");

  // The same user with an unpinned key is still served by A.
  const free = key("kfree");
  assert.equal((await enforceKeyLimits(free, "model-a")).ok, true);
});

test("an expired purchase of the pinned plan cannot pay", async () => {
  group(); plan("A");
  user();
  grant("A", { expiresAt: new Date(Date.now() - 1000).toISOString() });
  const secret = key("k1", { planId: "A" });

  const result = await enforceKeyLimits(secret, "model-a");
  assert.equal(result.status, 402);
});

test("a charge for a pinned key is taken from that plan only, and a shortfall is debt", () => {
  plan("A"); plan("B");
  user();
  const upA = grant("A", { usd: 100, priority: 1 });
  const upB = grant("B", { usd: 1, priority: 2 });

  const res = chargeSync(db, { userId: "u1", requestKey: "r1", costNanoUsd: USD(3), planId: "B" });
  assert.deepEqual(res.parts.map((p) => p.userPlanId), [upB], "only B pays");
  assert.equal(res.debtNanoUsd, USD(2), "B only had $1: the rest is debt, A is not touched");
  const a = db.get(`SELECT creditRemainingNanoUsd AS left FROM userPlans WHERE id = ?`, [upA]);
  assert.equal(a.left, USD(100));

  // An unpinned charge still starts from the head of the queue.
  const open = chargeSync(db, { userId: "u1", requestKey: "r2", costNanoUsd: USD(1) });
  assert.deepEqual(open.parts.map((p) => p.userPlanId), [upA]);
});

// ── Rate allowance per plan ────────────────────────────────────────────────

test("which plan's allowance a request counts against", () => {
  plan("A"); plan("B");
  user();
  grant("A", { priority: 1 });
  grant("B", { priority: 2 });

  assert.equal(ratePlanIdSync(db, "u1", null), "A", "unpinned: the plan paying now");
  assert.equal(ratePlanIdSync(db, "u1", "B"), "B", "pinned: the pinned plan");
});

test("saving usage records the plan allowance for pinned and unpinned keys", async () => {
  plan("A"); plan("B");
  user();
  grant("A", { priority: 1 });
  grant("B", { priority: 2 });
  const pinned = key("kb", { planId: "B" });
  const open = key("ko");

  await saveRequestUsage({ provider: "test", model: "m", apiKey: pinned, tokens: { prompt_tokens: 1, completion_tokens: 1 }, endpoint: "/v1/chat/completions" });
  await saveRequestUsage({ provider: "test", model: "m", apiKey: open, tokens: { prompt_tokens: 2, completion_tokens: 2 }, endpoint: "/v1/chat/completions" });

  const rows = db.all(`SELECT apiKeyId, ratePlanId FROM usageHistory ORDER BY id`);
  assert.deepEqual(rows, [
    { apiKeyId: "kb", ratePlanId: "B" },
    { apiKeyId: "ko", ratePlanId: "A" },
  ]);
});

test("many keys on one plan share a single RPM allowance", async () => {
  group(); plan("A", { rpm: 6 });
  user();
  grant("A");
  const k1 = key("k1", { planId: "A" });
  const k2 = key("k2", { planId: "A" });
  const k3 = key("k3"); // unpinned: paid by A, so it counts in A's allowance too

  for (let i = 0; i < 2; i += 1) usageRow("k1", "A");
  for (let i = 0; i < 2; i += 1) usageRow("k2", "A");
  for (let i = 0; i < 2; i += 1) usageRow("k3", "A");

  for (const secret of [k1, k2, k3]) {
    const result = await enforceKeyLimits(secret, "model-a");
    assert.equal(result.ok, false, "six requests across three keys exhaust 6 RPM for every key");
    assert.equal(result.status, 429);
    assert.equal(result.code, "rate_limit");
    assert.match(result.message, /RPM/);
  }
});

test("two purchases of the same plan share one allowance", async () => {
  group(); plan("A", { rpm: 2 });
  user();
  grant("A"); grant("A");
  const secret = key("k1", { planId: "A" });
  usageRow("k1", "A"); usageRow("k1", "A");

  assert.equal((await enforceKeyLimits(secret, "model-a")).ok, false, "buying A twice does not double its RPM");
});

test("a different plan has its own allowance", async () => {
  group(); plan("A", { rpm: 1 }); plan("B", { rpm: 1 });
  user();
  grant("A", { priority: 1 }); grant("B", { priority: 2 });
  const onA = key("ka", { planId: "A" });
  const onB = key("kb", { planId: "B" });
  usageRow("ka", "A");

  assert.equal((await enforceKeyLimits(onA, "model-a")).ok, false, "A is used up");
  assert.equal((await enforceKeyLimits(onB, "model-a")).ok, true, "B's allowance is separate and untouched");
});

test("TPM is shared by the keys of one plan", async () => {
  group(); plan("A", { tpm: 100 });
  user();
  grant("A");
  const k2 = key("k2", { planId: "A" });
  key("k1", { planId: "A" });
  usageRow("k1", "A", { prompt: 60, completion: 60 });

  const result = await enforceKeyLimits(k2, "model-a");
  assert.equal(result.ok, false);
  assert.equal(result.code, "rate_limit");
  assert.match(result.message, /TPM/);
});

test("the allowance is per user: another user's usage on the same plan does not count", async () => {
  group(); plan("A", { rpm: 1 });
  user("u1"); user("u2");
  grant("A", { userId: "u1" }); grant("A", { userId: "u2" });
  key("k1", { userId: "u1", planId: "A" });
  const k2 = key("k2", { userId: "u2", planId: "A" });
  usageRow("k1", "A");

  assert.equal((await enforceKeyLimits(k2, "model-a")).ok, true);
});

// ── Choosing a plan for a key ───────────────────────────────────────────────

test("a key can be pinned only to a plan the user holds now", () => {
  plan("A"); plan("B"); plan("C");
  user("u1"); user("u2");
  grant("A", { userId: "u1" });
  grant("B", { userId: "u1", expiresAt: new Date(Date.now() - 1000).toISOString() }); // lapsed
  grant("C", { userId: "u2" }); // someone else's

  assert.deepEqual(listBindablePlansSync(db, "u1").map((p) => p.id), ["A"]);

  for (const empty of [undefined, null, "", "all"]) {
    assert.deepEqual(resolveKeyPlanInputSync(db, "u1", empty), { ok: true, planId: null }, `${String(empty)} = all plans`);
  }
  assert.deepEqual(resolveKeyPlanInputSync(db, "u1", "A"), { ok: true, planId: "A" });
  assert.equal(resolveKeyPlanInputSync(db, "u1", "B").ok, false, "a lapsed plan is refused");
  assert.equal(resolveKeyPlanInputSync(db, "u1", "C").ok, false, "another user's plan is refused");
  assert.equal(resolveKeyPlanInputSync(db, "u1", "nope").ok, false);
  assert.equal(resolveKeyPlanInputSync(db, "u1", 5).ok, false);
});

test("the pin can be changed and cleared, and only exists on customer keys", async () => {
  plan("A");
  user();
  key("k1");
  const now = NOW();
  db.run(
    `INSERT INTO apiKeys(id, key, name, isActive, createdAt, updatedAt, userId, keyPrefix) VALUES('adm', 'secret-adm', 'adm', 1, ?, ?, NULL, 'secret-a')`,
    [now, now]
  );

  assert.equal((await updateApiKey("k1", { planId: "A" })).planId, "A");
  assert.equal((await getApiKeyById("k1")).planId, "A");
  assert.equal((await updateApiKey("k1", { planId: null })).planId, null);
  assert.equal((await updateApiKey("k1", { name: "renamed" })).planId, null, "an update without planId keeps the pin");

  assert.equal((await updateApiKey("adm", { planId: "A" })).planId, null, "an admin key cannot be pinned");
});

// ── Discounts follow the plan that pays ─────────────────────────────────────

test("a pinned key gets the discounts of its own plan, not the queue head's", () => {
  plan("A"); plan("B");
  user();
  grant("A", { priority: 1 });
  grant("B", { priority: 2 });
  for (const [scopeId, percent] of [["A", "10"], ["B", "50"]]) {
    const out = createDiscountSync(db, { scopeType: "plan", scopeId, percent, startsAt: null, endsAt: null }, { now: NOW() });
    assert.equal(out.ok, true, JSON.stringify(out.errors));
  }

  const unpinned = applyRequestDiscountSync(db, { listCostNanoUsd: USD(10), userId: "u1", requestedModel: "m" });
  assert.equal(unpinned.discountBp, 1000, "an unpinned request is discounted by the head plan A");

  const pinned = applyRequestDiscountSync(db, { listCostNanoUsd: USD(10), userId: "u1", requestedModel: "m", planId: "B" });
  assert.equal(pinned.discountBp, 5000, "a request on a key pinned to B gets B's rule");
  assert.equal(pinned.costNanoUsd, USD(5));
});
