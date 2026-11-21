// Bot-key access rules (spec api-access-enforcement "Customer keys take their model
// access from the owner's current group", "Bot keys reach only chat completions",
// plus spec business-bots "Business quota ..." as far as enforcement reads it).
//
// The two exceptions the business product adds are pinned here:
//   1. business models are outside EVERY customer key's allow-list but a bot's;
//   2. a bot key ignores the group and answers only the current business models,
//      only on `chat`, and only while its bot is active.
//
// Same fixture style as test/access-enforcement.test.js: rows by direct SQL, and
// `enforceKeyLimits` is the surface under test.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-biz-access-test-"));
process.env.DATA_DIR = tmpDir;
process.env.TPM_MAX_WAIT_MS = "0";

const { getAdapter } = await import("../src/lib/db/driver.js");
const { enforceKeyLimits } = await import("../src/lib/auth/keyEnforcement.js");
const { platformErrorBody, PLATFORM_MESSAGES } = await import("../src/lib/auth/platformError.js");
const { saveBusinessSettings, getBusinessSettings, validateBusinessSettings } = await import("../src/lib/biz/settings.js");
const { NANO } = await import("../src/shared/utils/money.js");

let db;
const USD = (n) => Math.round(n * NANO);
const NOW = () => new Date().toISOString();
const inDays = (d) => new Date(Date.now() + d * 86_400_000).toISOString();
const MB = 1024 * 1024;
const BUSINESS_MODELS = [
  { id: "delify-biz", label: "Biz" },
  { id: "delify-biz-pro", label: "Biz Pro" },
];

before(async () => { db = await getAdapter(); });

after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(async () => {
  for (const table of [
    "usageHistory", "creditLedger", "userPlans", "apiKeys", "users",
    "keyGroups", "plans", "settings", "bizBots", "combos",
  ]) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* partial schema */ }
  }
  // The production settings path, with the combos the list names.
  const now = NOW();
  for (const model of BUSINESS_MODELS) {
    db.run(
      `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, 'llm', '["a/b"]', ?, ?)`,
      [`c-${model.id}`, model.id, now, now]
    );
  }
  const saved = await saveBusinessSettings({
    businessModels: BUSINESS_MODELS,
    guardModel: "guard-model",
    embeddingModel: "embed-model",
  });
  assert.equal(saved.ok, true, saved.error);
});

// ── Fixtures ────────────────────────────────────────────────────────────────

function group(id, allowedModels = null) {
  const now = NOW();
  db.run(
    `INSERT INTO keyGroups(id, name, isActive, rpm, tpm, budgetUsd, resetWindow, allowedModels, priceOverrides, createdAt, updatedAt)
     VALUES(?, ?, 1, NULL, NULL, NULL, NULL, ?, NULL, ?, ?)`,
    [id, id, allowedModels ? JSON.stringify(allowedModels) : null, now, now]
  );
}

function user(id, groupId = null) {
  const now = NOW();
  db.run(
    `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
     VALUES(?, ?, 'x', NULL, ?, 'active', 0, ?, ?)`,
    [id, `${id}@test.local`, groupId, now, now]
  );
}

function key(id, { userId = null, botId = null } = {}) {
  const now = NOW();
  const secret = `secret-${id}`;
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, groupId, windowCostUsd, updatedAt, userId, botId, keyPrefix)
     VALUES(?, ?, ?, NULL, 1, ?, NULL, 0, ?, ?, ?, ?)`,
    [id, secret, id, now, now, userId, botId, secret.slice(0, 8)]
  );
  return secret;
}

function plan(id, { productLine = "api", maxBots = null, maxKbBytes = null } = {}) {
  const now = NOW();
  db.run(
    `INSERT INTO plans(id, code, name, priceNanoUsd, creditNanoUsd, durationDays, isActive, productLine, maxBots, maxKbBytes, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, 30, 1, ?, ?, ?, ?, ?)`,
    [id, id, id, USD(10), USD(100), productLine, maxBots, maxKbBytes, now, now]
  );
}

function grant(userId, planId, creditUsd = 50) {
  const now = NOW();
  db.run(
    `INSERT INTO userPlans(id, userId, planId, orderId, source, creditTotalNanoUsd, creditRemainingNanoUsd, startsAt, expiresAt, status, createdAt)
     VALUES(?, ?, ?, NULL, 'purchase', ?, ?, ?, ?, 'active', ?)`,
    [`up-${Math.random().toString(36).slice(2)}`, userId, planId, USD(creditUsd), USD(creditUsd), now, inDays(30), now]
  );
}

function bot(id, userId, { isActive = 1 } = {}) {
  const now = NOW();
  db.run(
    `INSERT INTO bizBots(id, userId, name, companyName, domainDescription, mode, refusalMessage, extraInstructions, modelId, isActive, createdAt, updatedAt)
     VALUES(?, ?, 'Bot', 'Công ty', 'Bán hàng nội thất gỗ tự nhiên', 'strict', 'x', '', 'delify-biz', ?, ?, ?)`,
    [id, userId, isActive, now, now]
  );
}

/** A customer with a live business plan, one bot and one bot key. */
function botFixture({ botActive = 1 } = {}) {
  group("g-open", null);
  user("u-bot", "g-open");
  plan("p-biz", { productLine: "business", maxBots: 2, maxKbBytes: 20 * MB });
  grant("u-bot", "p-biz");
  bot("b1", "u-bot", { isActive: botActive });
  return key("k-bot", { userId: "u-bot", botId: "b1" });
}

// ── Model reservation ───────────────────────────────────────────────────────

test("a normal customer key is refused a business model, whatever the group allows", async () => {
  group("g-all", null);
  user("u-normal", "g-all");
  plan("p-api");
  grant("u-normal", "p-api");
  const secret = key("k-normal", { userId: "u-normal" });

  const allowed = await enforceKeyLimits(secret, "normal-model");
  assert.equal(allowed.ok, true, "an ordinary model still passes");

  const denied = await enforceKeyLimits(secret, "delify-biz");
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 403);
  assert.equal(denied.code, "model_not_allowed");
  // A business model is not "in their group" whatever the group says; the message
  // stays the existing model_not_allowed one so clients need no second code path.
  assert.equal(denied.message, `Model delify-biz không nằm trong nhóm của bạn.`);
});

test("a bot key is refused a normal model", async () => {
  const secret = botFixture();
  const denied = await enforceKeyLimits(secret, "gpt-4o");
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 403);
  assert.equal(denied.code, "model_not_allowed");
});

test("a bot key is allowed exactly the business models", async () => {
  const secret = botFixture();
  for (const model of ["delify-biz", "delify-biz-pro"]) {
    const result = await enforceKeyLimits(secret, model, { endpoint: "chat" });
    assert.equal(result.ok, true, `${model}: ${result.code || ""} ${result.message || ""}`);
  }
});

test("a bot key does not need a group", async () => {
  // The bot's owner has no group: a bot key still works, because its model list is
  // the business list, not the group's.
  user("u-nogroup", null);
  plan("p-biz", { productLine: "business", maxBots: 1, maxKbBytes: 20 * MB });
  grant("u-nogroup", "p-biz");
  bot("b2", "u-nogroup");
  const secret = key("k-bot2", { userId: "u-nogroup", botId: "b2" });

  const result = await enforceKeyLimits(secret, "delify-biz", { endpoint: "chat" });
  assert.equal(result.ok, true, result.message);
});

// ── Endpoint fence ──────────────────────────────────────────────────────────

test("a bot key is refused on every non-chat endpoint", async () => {
  const secret = botFixture();
  for (const endpoint of ["messages", "responses", "embeddings", "images", "tts", "stt", "search", "fetch", "videos"]) {
    const denied = await enforceKeyLimits(secret, "delify-biz", { endpoint });
    assert.equal(denied.ok, false, endpoint);
    assert.equal(denied.status, 403, endpoint);
    assert.equal(denied.code, "endpoint_not_allowed", endpoint);
    assert.equal(denied.message, PLATFORM_MESSAGES.endpoint_not_allowed);
  }
  // The chat endpoint is the one it may use.
  const allowed = await enforceKeyLimits(secret, "delify-biz", { endpoint: "chat" });
  assert.equal(allowed.ok, true);
});

test("a disabled bot refuses its key with 403 bot_disabled", async () => {
  const secret = botFixture({ botActive: 0 });
  const denied = await enforceKeyLimits(secret, "delify-biz", { endpoint: "chat" });
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 403);
  assert.equal(denied.code, "bot_disabled");
  assert.equal(denied.message, "Chatbot này đang tắt");
});

test("a bot row that no longer exists reads as a disabled bot", async () => {
  const secret = botFixture();
  db.run(`DELETE FROM bizBots WHERE id = 'b1'`);
  const denied = await enforceKeyLimits(secret, "delify-biz", { endpoint: "chat" });
  assert.equal(denied.code, "bot_disabled");
});

test("every denial uses the platform error format", () => {
  const endpoint = platformErrorBody({
    status: 403,
    code: "endpoint_not_allowed",
    message: PLATFORM_MESSAGES.endpoint_not_allowed,
  });
  assert.equal(endpoint.error.type, "permission_error");
  assert.equal(endpoint.error.code, "endpoint_not_allowed");

  const unavailable = platformErrorBody({
    status: 503,
    code: "guard_unavailable",
    message: PLATFORM_MESSAGES.guard_unavailable,
  });
  assert.equal(unavailable.error.type, "service_unavailable");
});

// ── Product line for the bot's key ──────────────────────────────────────────

test("a bot key is paid by the business line only", async () => {
  group("g-open", null);
  user("u-lines", "g-open");
  plan("p-api");
  plan("p-biz", { productLine: "business", maxBots: 1, maxKbBytes: 20 * MB });
  // A live api purchase with plenty of credit and no business purchase.
  grant("u-lines", "p-api", 100);
  bot("b-lines", "u-lines");
  const secret = key("k-lines", { userId: "u-lines", botId: "b-lines" });

  const denied = await enforceKeyLimits(secret, "delify-biz", { endpoint: "chat" });
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 402);
  assert.equal(denied.code, "insufficient_quota");
  assert.equal(denied.message, "Hết quota gói AI doanh nghiệp — mua gói tại /doanh-nghiep");
});

// ── Settings validation ─────────────────────────────────────────────────────

test("an unknown business combo is refused with the combo named", async () => {
  const invalid = validateBusinessSettings(
    { businessModels: [{ id: "delify-biz-ghost", label: "" }] },
    { comboNames: ["delify-biz"] }
  );
  assert.equal(invalid, "Model doanh nghiệp phải là một combo đã có: delify-biz-ghost");
});

test("a duplicated business combo is refused", () => {
  const invalid = validateBusinessSettings(
    { businessModels: [{ id: "delify-biz", label: "" }, { id: "delify-biz", label: "" }] },
    { comboNames: ["delify-biz"] }
  );
  assert.match(invalid, /trùng/);
});

test("saving settings through the real path validates against the combos table", async () => {
  const unknown = await saveBusinessSettings({ businessModels: [{ id: "nope", label: "" }] });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /combo đã có: nope/);

  const ok = await saveBusinessSettings({ relevanceThreshold: 0.42 });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.business.relevanceThreshold, 0.42);

  const stored = await getBusinessSettings();
  assert.equal(stored.relevanceThreshold, 0.42);
  assert.deepEqual(stored.businessModels.map((model) => model.id), ["delify-biz", "delify-biz-pro"]);
  // Out-of-range threshold.
  assert.match(validateBusinessSettings({ relevanceThreshold: 2 }), /0 đến 1/);
});

test("the defaults are the spec's texts", async () => {
  db.run(`DELETE FROM settings`);
  const stored = await getBusinessSettings();
  assert.equal(stored.relevanceThreshold, 0.3);
  assert.deepEqual(stored.businessModels, []);
  assert.match(stored.sovereigntyAnswer, /Hoàng Sa và quần đảo Trường Sa/);
  assert.match(stored.politicalRefusal, /không thảo luận về các chủ đề chính trị/);
});
