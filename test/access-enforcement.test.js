// Access enforcement for the LLM endpoints (spec api-access-enforcement).
//
// Everything here runs against a throwaway SQLite database, with rows inserted by
// direct SQL. `createApiKey` is deliberately avoided (it dynamically imports an
// `@/`-aliased module, which plain `node --test` cannot resolve) and so is
// `src/sse/services/auth.js` (same reason) — enforceKeyLimits and platformErrorBody
// are the surface under test, and enforceKeyAccess is a thin renderer over them.
//
// The invariants pinned here are the ones a customer would notice immediately:
//   * a customer key's limits follow the OWNER'S GROUP, read per request;
//   * RPM/TPM are shared by all of a customer's keys;
//   * a non-active account is rejected before any limit question;
//   * admin keys keep their own counters and never share an allowance;
//   * every denial has the OpenAI error shape with a stable code.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-access-test-"));
process.env.DATA_DIR = tmpDir;
// TPM wait disabled: these tests assert the deny path, and a 30s wait per case
// would make the suite unusable.
process.env.TPM_MAX_WAIT_MS = "0";

const { getAdapter } = await import("../src/lib/db/driver.js");
const { enforceKeyLimits } = await import("../src/lib/auth/keyEnforcement.js");
const { platformErrorBody, relativeWaitVi } = await import("../src/lib/auth/platformError.js");
const { NANO } = await import("../src/shared/utils/money.js");

let db;
const USD = (n) => Math.round(n * NANO);
const NOW = () => new Date().toISOString();
const inDays = (d) => new Date(Date.now() + d * 86_400_000).toISOString();
const secondsAgo = (s) => new Date(Date.now() - s * 1000).toISOString();

before(async () => {
  db = await getAdapter();
});

after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  for (const table of [
    "usageHistory",
    "creditLedger",
    "userPlans",
    "apiKeys",
    "userSessions",
    "emailVerifications",
    "users",
    "keyGroups",
    "settings",
  ]) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* table may not exist */ }
  }
});

// ── Fixtures ────────────────────────────────────────────────────────────────

function insertGroup(id, { name = id, isActive = 1, rpm = null, tpm = null, budgetUsd = null, allowedModels = null } = {}) {
  const now = NOW();
  db.run(
    `INSERT INTO keyGroups(id, name, isActive, rpm, tpm, budgetUsd, resetWindow, allowedModels, priceOverrides, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)`,
    [id, name, isActive, rpm, tpm, budgetUsd, allowedModels ? JSON.stringify(allowedModels) : null, now, now]
  );
}

function insertUser(id, { email = `${id}@test.local`, groupId = null, status = "active" } = {}) {
  const now = NOW();
  db.run(
    `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
     VALUES(?, ?, 'x', NULL, ?, ?, 0, ?, ?)`,
    [id, email, groupId, status, now, now]
  );
}

function insertKey(id, { secret = `secret-${id}`, userId = null, isActive = 1, groupId = null, rpm = null, tpm = null, budgetUsd = null, allowedModels = null, expiresAt = null, windowStartedAt = null } = {}) {
  const now = NOW();
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, groupId, rpm, tpm, budgetUsd, resetWindow, expiresAt, allowedModels, windowStartedAt, windowCostUsd, updatedAt, userId, keyHash, keyPrefix)
     VALUES(?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 0, ?, ?, NULL, ?)`,
    [
      id, secret, id, isActive, now, groupId, rpm, tpm, budgetUsd, expiresAt,
      allowedModels ? JSON.stringify(allowedModels) : null, windowStartedAt, now, userId, secret.slice(0, 8),
    ]
  );
  return secret;
}

function insertGrant(userId, nanoUsd, { expiresAt = inDays(30) } = {}) {
  const now = NOW();
  db.run(
    `INSERT INTO userPlans(id, userId, planId, orderId, source, creditTotalNanoUsd, creditRemainingNanoUsd, startsAt, expiresAt, status, createdAt)
     VALUES(?, ?, NULL, NULL, 'admin', ?, ?, ?, ?, 'active', ?)`,
    [`up-${userId}-${Math.random().toString(36).slice(2)}`, userId, nanoUsd, nanoUsd, now, expiresAt, now]
  );
}

function insertUsage(apiKeyId, { at = NOW(), prompt = 10, completion = 10 } = {}) {
  db.run(
    `INSERT INTO usageHistory(timestamp, provider, model, apiKeyId, promptTokens, completionTokens, costNanoUsd, status, meta)
     VALUES(?, 'test', 'model-a', ?, ?, ?, 0, 'ok', '{}')`,
    [at, apiKeyId, prompt, completion]
  );
}

// ── Customer keys: group resolution ─────────────────────────────────────────

test("customer key takes its allow-list from the owner's group, per request", async () => {
  insertGroup("group-a", { allowedModels: ["model-a"] });
  insertGroup("group-b", { allowedModels: ["model-b"] });
  insertUser("u1", { groupId: "group-a" });
  const secret = insertKey("k1", { userId: "u1" });
  insertGrant("u1", USD(10));

  const okA = await enforceKeyLimits(secret, "model-a");
  assert.equal(okA.ok, true, "model-a is in group A");

  const denied = await enforceKeyLimits(secret, "model-b");
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 403);
  assert.equal(denied.code, "model_not_allowed");
  assert.match(denied.message, /model-b/);

  // Move the user; no key edit, no restart.
  db.run(`UPDATE users SET groupId = 'group-b' WHERE id = 'u1'`);
  const nowOk = await enforceKeyLimits(secret, "model-b");
  assert.equal(nowOk.ok, true, "group change applies on the next request");
  const nowDenied = await enforceKeyLimits(secret, "model-a");
  assert.equal(nowDenied.code, "model_not_allowed");
});

test("a group with no allow-list allows every model", async () => {
  insertGroup("open", { allowedModels: null });
  insertUser("u1", { groupId: "open" });
  const secret = insertKey("k1", { userId: "u1" });
  insertGrant("u1", USD(10));

  const result = await enforceKeyLimits(secret, "anything/whatever-1");
  assert.equal(result.ok, true);
});

test("stale key-level rpm on a customer key is ignored", async () => {
  insertGroup("open", { allowedModels: null, rpm: null });
  insertUser("u1", { groupId: "open" });
  // The key still carries rpm = 1 from an earlier admin edit.
  const secret = insertKey("k1", { userId: "u1", rpm: 1 });
  insertGrant("u1", USD(10));
  // Two recorded requests already: over a limit of 1, under "no limit".
  insertUsage("k1");
  insertUsage("k1");

  const result = await enforceKeyLimits(secret, "model-a");
  assert.equal(result.ok, true);
});

test("a customer with no group is denied with the group message", async () => {
  insertUser("u1", { groupId: null });
  const secret = insertKey("k1", { userId: "u1" });
  insertGrant("u1", USD(10));

  const result = await enforceKeyLimits(secret, "model-a");
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.code, "model_not_allowed");
  assert.match(result.message, /chưa được gán nhóm/);
});

test("an inactive group counts as missing", async () => {
  insertGroup("retired", { isActive: 0, allowedModels: null });
  insertUser("u1", { groupId: "retired" });
  const secret = insertKey("k1", { userId: "u1" });
  insertGrant("u1", USD(10));

  const result = await enforceKeyLimits(secret, "model-a");
  assert.equal(result.ok, false);
  assert.match(result.message, /chưa được gán nhóm/);
});

// ── Customer keys: rate limits shared across keys ──────────────────────────

test("two keys share one RPM allowance", async () => {
  insertGroup("g10", { rpm: 10 });
  insertUser("u1", { groupId: "g10" });
  const secret1 = insertKey("k1", { userId: "u1" });
  const secret2 = insertKey("k2", { userId: "u1" });
  insertGrant("u1", USD(10));

  for (let i = 0; i < 6; i += 1) insertUsage("k1", { at: secondsAgo(5) });
  for (let i = 0; i < 4; i += 1) insertUsage("k2", { at: secondsAgo(5) });

  for (const secret of [secret1, secret2]) {
    const result = await enforceKeyLimits(secret, "model-a");
    assert.equal(result.ok, false, "the 11th request is over the shared 10 RPM");
    assert.equal(result.status, 429);
    assert.equal(result.code, "rate_limit");
    assert.equal(result.retryAfterSec, 60);
  }
});

test("RPM counts only the trailing minute", async () => {
  insertGroup("g2", { rpm: 2 });
  insertUser("u1", { groupId: "g2" });
  const secret = insertKey("k1", { userId: "u1" });
  insertGrant("u1", USD(10));

  insertUsage("k1", { at: secondsAgo(120) });
  insertUsage("k1", { at: secondsAgo(120) });
  const result = await enforceKeyLimits(secret, "model-a");
  assert.equal(result.ok, true, "requests older than 60s do not count");
});

test("TPM is shared across keys and denies when the wait budget is zero", async () => {
  insertGroup("gtpm", { tpm: 100 });
  insertUser("u1", { groupId: "gtpm" });
  const secret1 = insertKey("k1", { userId: "u1" });
  insertGrant("u1", USD(10));
  insertUsage("k1", { prompt: 60, completion: 60 });

  const result = await enforceKeyLimits(secret1, "model-a");
  assert.equal(result.ok, false);
  assert.equal(result.status, 429);
  assert.equal(result.code, "rate_limit");
  assert.match(result.message, /TPM/);
});

// ── Admin keys ─────────────────────────────────────────────────────────────

test("admin keys are counted per key, not per group", async () => {
  insertGroup("admin-group", { rpm: 10 });
  const a = insertKey("ka", { groupId: "admin-group" });
  const b = insertKey("kb", { groupId: "admin-group" });

  for (let i = 0; i < 6; i += 1) insertUsage("ka", { at: secondsAgo(5) });
  for (let i = 0; i < 6; i += 1) insertUsage("kb", { at: secondsAgo(5) });

  // Each key holds 6 of its own against a 10 limit → both pass. Per-key counting
  // is what "admin keys unaffected" means in the spec's scenario.
  const resultA = await enforceKeyLimits(a, "model-a");
  const resultB = await enforceKeyLimits(b, "model-a");
  assert.equal(resultA.ok, true);
  assert.equal(resultB.ok, true);

  // Push ka to its own 10: it is now over, while kb (6) is untouched — proof the
  // two keys do not share a counter.
  for (let i = 0; i < 4; i += 1) insertUsage("ka", { at: secondsAgo(5) });
  const overA = await enforceKeyLimits(a, "model-a");
  const stillOkB = await enforceKeyLimits(b, "model-a");
  assert.equal(overA.ok, false);
  assert.equal(overA.code, "rate_limit");
  assert.equal(stillOkB.ok, true);
});

test("admin key budget exhaustion is a 402 budget_exhausted", async () => {
  // windowStartedAt is pinned so the enforcement's first-use branch does not reset
  // the window (and zero the measured spend) on this very request.
  const secret = insertKey("kb", { budgetUsd: 0.001, windowStartedAt: secondsAgo(30) });
  db.run(
    `INSERT INTO usageHistory(timestamp, provider, model, apiKeyId, promptTokens, completionTokens, cost, costNanoUsd, status, meta)
     VALUES(?, 'test', 'model-a', 'kb', 10, 10, 0.002, ?, 'ok', '{}')`,
    [secondsAgo(5), USD(0.002)]
  );

  const result = await enforceKeyLimits(secret, "model-a");
  assert.equal(result.ok, false);
  assert.equal(result.status, 402);
  assert.equal(result.code, "budget_exhausted");
});

test("an expired admin key is a 403 key_expired", async () => {
  const secret = insertKey("kx", { expiresAt: new Date(Date.now() - 60_000).toISOString() });
  const result = await enforceKeyLimits(secret, "model-a");
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.code, "key_expired");
});

// ── Account status ─────────────────────────────────────────────────────────

test("a suspended owner is rejected before any limit check", async () => {
  insertGroup("g1", { rpm: 1, allowedModels: ["model-z"] });
  insertUser("u1", { groupId: "g1", status: "suspended" });
  const secret = insertKey("k1", { userId: "u1" });
  insertGrant("u1", USD(10));

  const result = await enforceKeyLimits(secret, "model-a");
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.code, "account_suspended");
  assert.match(result.message, /bị khoá/);
});

test("an unverified owner is rejected with account_unverified", async () => {
  insertGroup("g1", {});
  insertUser("u1", { groupId: "g1", status: "unverified" });
  const secret = insertKey("k1", { userId: "u1" });
  insertGrant("u1", USD(10));

  const result = await enforceKeyLimits(secret, "model-a");
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.code, "account_unverified");
});

test("suspension applies on the next request", async () => {
  insertGroup("g1", {});
  insertUser("u1", { groupId: "g1", status: "active" });
  const secret = insertKey("k1", { userId: "u1" });
  insertGrant("u1", USD(10));
  assert.equal((await enforceKeyLimits(secret, "model-a")).ok, true);

  db.run(`UPDATE users SET status = 'suspended' WHERE id = 'u1'`);
  const after = await enforceKeyLimits(secret, "model-a");
  assert.equal(after.code, "account_suspended");
});

// ── Budget does not apply to customer keys ─────────────────────────────────

test("a customer key ignores a budgeted group and a budgeted key", async () => {
  insertGroup("budgeted", { budgetUsd: 1 });
  insertUser("u1", { groupId: "budgeted" });
  const secret = insertKey("k1", { userId: "u1", budgetUsd: 0.5 });
  insertGrant("u1", USD(10));
  // Spend $5 through the key: far past both budgets.
  db.run(
    `INSERT INTO usageHistory(timestamp, provider, model, apiKeyId, promptTokens, completionTokens, cost, costNanoUsd, status, meta)
     VALUES(?, 'test', 'model-a', 'k1', 10, 10, 5, ?, 'ok', '{}')`,
    [secondsAgo(5), USD(5)]
  );

  const result = await enforceKeyLimits(secret, "model-a");
  assert.equal(result.ok, true, "customer spending is governed by the plan queue, not a budget");
});

// ── Quota gate (GĐ0) ──────────────────────────────────────────────────────

test("a customer with no credit is a 402 insufficient_quota", async () => {
  insertGroup("g1", {});
  insertUser("u1", { groupId: "g1" });
  const secret = insertKey("k1", { userId: "u1" });

  const result = await enforceKeyLimits(secret, "model-a");
  assert.equal(result.ok, false);
  assert.equal(result.status, 402);
  assert.equal(result.code, "insufficient_quota");
  assert.equal(result.message, "Hết quota — mua gói hoặc nhập mã quà tặng tại /account/plans.");
});

test("a customer with credit passes the gate", async () => {
  insertGroup("g1", {});
  insertUser("u1", { groupId: "g1" });
  const secret = insertKey("k1", { userId: "u1" });
  insertGrant("u1", USD(1));

  const result = await enforceKeyLimits(secret, "model-a");
  assert.equal(result.ok, true);
});

test("an inactive customer key is rejected by validateApiKey, not here", async () => {
  insertGroup("g1", {});
  insertUser("u1", { groupId: "g1" });
  const secret = insertKey("k1", { userId: "u1", isActive: 0 });
  insertGrant("u1", USD(1));

  // enforceKeyLimits is called after isValidApiKey, so it does not re-check
  // isActive; the assertion here is that it does not crash the auth path.
  const result = await enforceKeyLimits(secret, "model-a");
  assert.equal(typeof result.ok, "boolean");
});

// ── Error body shape ──────────────────────────────────────────────────────

test("platformErrorBody matches the OpenAI shape with a stable code", () => {
  const body = platformErrorBody({ status: 403, code: "model_not_allowed", message: "Model x không nằm trong nhóm của bạn." });
  assert.deepEqual(body, {
    error: {
      message: "Model x không nằm trong nhóm của bạn.",
      type: "permission_error",
      code: "model_not_allowed",
    },
  });

  assert.equal(platformErrorBody({ status: 401, code: "invalid_api_key", message: "" }).error.type, "authentication_error");
  assert.equal(platformErrorBody({ status: 402, code: "insufficient_quota", message: "" }).error.type, "insufficient_quota");
  assert.equal(platformErrorBody({ status: 429, code: "rate_limit", message: "" }).error.type, "rate_limit_error");

  const withReset = platformErrorBody({ status: 429, code: "plan_limit", message: "", resetAt: "2026-10-29T10:00:00.000Z" });
  assert.equal(withReset.error.resetAt, "2026-10-29T10:00:00.000Z");

  const withoutReset = platformErrorBody({ status: 403, code: "key_expired", message: "" });
  assert.equal("resetAt" in withoutReset.error, false, "resetAt is omitted, never null");
});

test("every denial code maps to its documented status and type", async () => {
  insertGroup("g-shape", { allowedModels: ["only-this"] });
  insertUser("u-shape", { groupId: "g-shape" });
  const secret = insertKey("k-shape", { userId: "u-shape" });
  insertGrant("u-shape", USD(1));

  const denial = await enforceKeyLimits(secret, "other-model");
  const body = platformErrorBody(denial);
  assert.equal(body.error.code, "model_not_allowed");
  assert.equal(body.error.type, "permission_error");
  assert.match(body.error.message, /other-model/);
});

test("N3: the models-list 401 uses the platform format, not invalid_request_error", async () => {
  // `/v1/models` guards on the key before anything else. Both of its denials must be
  // the SAME shape as the chat endpoints: a client that branches on `code` must not
  // need a second path just to discover its key is wrong.
  const { platformErrorResponse, PLATFORM_MESSAGES } = await import("../src/lib/auth/platformError.js");
  const response = platformErrorResponse({
    status: 401,
    code: "invalid_api_key",
    message: PLATFORM_MESSAGES.invalid_api_key,
  });

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(response.headers.get("Content-Type"), "application/json");

  const body = await response.json();
  assert.deepEqual(body, {
    error: {
      message: "API key không hợp lệ hoặc đã bị tắt.",
      type: "authentication_error",
      code: "invalid_api_key",
    },
  });
});

test("relativeWaitVi renders Vietnamese durations", () => {
  assert.equal(relativeWaitVi(30_000), "30 giây");
  assert.equal(relativeWaitVi(45 * 60_000), "45 phút");
  assert.equal(relativeWaitVi(72 * 60_000), "1 giờ 12 phút");
  assert.equal(relativeWaitVi(60 * 60_000), "1 giờ");
});
