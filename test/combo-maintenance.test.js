// Combo maintenance (spec api-access-enforcement "A combo can be put under maintenance").
// Rows are inserted by direct SQL into a throwaway database, like access-enforcement.test.js.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-maintenance-test-"));
process.env.DATA_DIR = tmpDir;
process.env.TPM_MAX_WAIT_MS = "0";

const { getAdapter } = await import("../src/lib/db/driver.js");
const { enforceKeyLimits } = await import("../src/lib/auth/keyEnforcement.js");
const { platformErrorBody } = await import("../src/lib/auth/platformError.js");
const { NANO } = await import("../src/shared/utils/money.js");

let db;
const USD = (n) => Math.round(n * NANO);
const NOW = () => new Date().toISOString();
const inDays = (d) => new Date(Date.now() + d * 86_400_000).toISOString();

before(async () => { db = await getAdapter(); });
after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(() => {
  for (const t of ["usageHistory", "creditLedger", "userPlans", "apiKeys", "users", "keyGroups", "plans", "settings", "combos"]) {
    try { db.run(`DELETE FROM ${t}`); } catch { /* table may not exist */ }
  }
});

function insertCombo(name, meta = {}) {
  const now = NOW();
  db.run(`INSERT INTO combos(id, name, kind, models, meta, createdAt, updatedAt) VALUES(?, ?, 'llm', ?, ?, ?, ?)`,
    [`c-${name}`, name, JSON.stringify(["openai/gpt-x"]), JSON.stringify(meta), now, now]);
}
function setMeta(name, meta) {
  db.run(`UPDATE combos SET meta = ? WHERE name = ?`, [JSON.stringify(meta), name]);
}
function insertGroup(id, allowedModels = null) {
  const now = NOW();
  db.run(`INSERT INTO keyGroups(id, name, isActive, rpm, tpm, budgetUsd, resetWindow, allowedModels, priceOverrides, createdAt, updatedAt)
          VALUES(?, ?, 1, NULL, NULL, NULL, NULL, ?, NULL, ?, ?)`, [id, id, allowedModels ? JSON.stringify(allowedModels) : null, now, now]);
}
function insertUser(id, groupId) {
  const now = NOW();
  db.run(`INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
          VALUES(?, ?, 'x', NULL, ?, 'active', 0, ?, ?)`, [id, `${id}@test.local`, groupId, now, now]);
}
function insertKey(id, { userId = null } = {}) {
  const now = NOW(); const secret = `secret-${id}`;
  db.run(`INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, groupId, rpm, tpm, budgetUsd, resetWindow, expiresAt, allowedModels, windowStartedAt, windowCostUsd, updatedAt, userId, keyHash, keyPrefix)
          VALUES(?, ?, ?, NULL, 1, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, ?, ?, NULL, ?)`,
    [id, secret, id, now, now, userId, secret.slice(0, 8)]);
  return secret;
}
function insertGrant(userId, nanoUsd) {
  const now = NOW();
  db.run(`INSERT INTO userPlans(id, userId, planId, orderId, source, creditTotalNanoUsd, creditRemainingNanoUsd, startsAt, expiresAt, status, priority, createdAt)
          VALUES(?, ?, NULL, NULL, 'admin', ?, ?, ?, ?, 'active', NULL, ?)`, [`up-${userId}`, userId, nanoUsd, nanoUsd, now, inDays(30), now]);
}

test("a customer calling a combo under maintenance gets 503 model_maintenance", async () => {
  insertCombo("gpt", { maintenance: true });
  insertGroup("g");
  insertUser("u1", "g");
  const secret = insertKey("k1", { userId: "u1" });
  insertGrant("u1", USD(10));

  const r = await enforceKeyLimits(secret, "gpt");
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
  assert.equal(r.code, "model_maintenance");
  assert.match(r.message, /gpt/);
  assert.deepEqual(Object.keys(platformErrorBody(r).error).sort(), ["code", "message", "type"]);
  assert.equal(platformErrorBody(r).error.type, "server_error");
});

test("turning maintenance off makes the combo callable on the next request", async () => {
  insertCombo("gpt", { maintenance: true });
  insertGroup("g");
  insertUser("u1", "g");
  const secret = insertKey("k1", { userId: "u1" });
  insertGrant("u1", USD(10));
  assert.equal((await enforceKeyLimits(secret, "gpt")).code, "model_maintenance");
  setMeta("gpt", {});
  assert.equal((await enforceKeyLimits(secret, "gpt")).ok, true);
});

test("a model outside the group is still 403, not 503", async () => {
  insertCombo("gpt", { maintenance: true });
  insertGroup("g", ["other"]);
  insertUser("u1", "g");
  const secret = insertKey("k1", { userId: "u1" });
  insertGrant("u1", USD(10));
  assert.equal((await enforceKeyLimits(secret, "gpt")).code, "model_not_allowed");
});

test("maintenance is reported before quota: a customer with no credit still gets 503", async () => {
  insertCombo("gpt", { maintenance: true });
  insertGroup("g");
  insertUser("u1", "g");
  const secret = insertKey("k1", { userId: "u1" });
  const r = await enforceKeyLimits(secret, "gpt");
  assert.equal(r.status, 503);
});

test("an admin key is refused too", async () => {
  insertCombo("gpt", { maintenance: true });
  const secret = insertKey("ak");
  const r = await enforceKeyLimits(secret, "gpt");
  assert.equal(r.status, 503);
  assert.equal(r.code, "model_maintenance");
});

test("other combos and provider/model names are not affected", async () => {
  insertCombo("gpt", { maintenance: true });
  insertCombo("fast", {});
  const secret = insertKey("ak");
  assert.equal((await enforceKeyLimits(secret, "fast")).ok, true);
  assert.equal((await enforceKeyLimits(secret, "openai/gpt-x")).ok, true);
  assert.equal((await enforceKeyLimits(secret, undefined)).ok, true, "no model named (non-chat endpoint)");
});

test("an unknown key is not refused here (the handler's own check rejects it)", async () => {
  insertCombo("gpt", { maintenance: true });
  const r = await enforceKeyLimits("no-such-key", "gpt");
  assert.equal(r.ok, true);
});
