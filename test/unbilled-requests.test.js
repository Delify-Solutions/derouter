// Requests that used to be served without a charge:
//   1. a customer key deleted while its requests were still running — usage is
//      charged when a request FINISHES, and the owner lookup found no key row;
//   2. endpoints that never record usage (TTS, STT, search, web fetch, video) —
//      customer keys are refused there until those endpoints are metered.
//
// Rows are seeded by direct SQL against a throwaway SQLite database; only relative
// imports are used because plain `node --test` cannot resolve the `@/` alias.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-unbilled-test-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const { saveRequestUsage } = await import("../src/lib/db/repos/usageRepo.js");
const { deleteApiKeySync, hashApiKey, DELETED_KEY_RETENTION_MS } = await import("../src/lib/db/repos/apiKeysRepo.js");
const { resolveApiKeyOwner } = await import("../src/lib/db/repos/billingRepo.js");
const { updatePricing } = await import("../src/lib/db/repos/pricingRepo.js");
const { refuseUnmeteredSync, UNMETERED_ENDPOINT_MESSAGE } = await import("../src/lib/auth/unmeteredEndpoints.js");
const { NANO } = await import("../src/shared/utils/money.js");

let db;
const USD = (n) => Math.round(n * NANO);
const NOW = () => new Date().toISOString();
const inDays = (d) => new Date(Date.now() + d * 86_400_000).toISOString();

before(async () => {
  db = await getAdapter();
  // $1 per 1M input tokens, so a 1M-token request costs exactly $1.
  await updatePricing({ test: { "model-a": { input: 1, output: 1 } } });
});

after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  for (const table of ["usageHistory", "creditLedger", "userPlanWindows", "userPlans", "apiKeys", "deletedApiKeys", "users", "plans"]) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* table may not exist */ }
  }
});

// ── Fixtures ────────────────────────────────────────────────────────────────

let keySeq = 0;

function user(id = "u1") {
  const now = NOW();
  db.run(
    `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
     VALUES(?, ?, 'x', NULL, NULL, 'active', 0, ?, ?)`,
    [id, `${id}@test.local`, now, now]
  );
}

function plan(id) {
  const now = NOW();
  db.run(
    `INSERT INTO plans(id, code, name, priceNanoUsd, creditNanoUsd, durationDays, isActive, createdAt, updatedAt)
     VALUES(?, ?, ?, 0, ?, 30, 1, ?, ?)`,
    [id, id, `Plan ${id}`, USD(100), now, now]
  );
}

function grant(planId, { userId = "u1", usd = 10, priority = null } = {}) {
  const now = NOW();
  const id = `up-${planId}`;
  db.run(
    `INSERT INTO userPlans(id, userId, planId, orderId, source, creditTotalNanoUsd, creditRemainingNanoUsd, startsAt, expiresAt, status, priority, createdAt)
     VALUES(?, ?, ?, NULL, 'purchase', ?, ?, ?, ?, 'active', ?, ?)`,
    [id, userId, planId, USD(usd), USD(usd), now, inDays(30), priority, now]
  );
  return id;
}

// Unique secrets per test: resolveApiKeyOwner caches by key string for 60 s.
function key(id, { userId = "u1", planId = null } = {}) {
  keySeq += 1;
  const now = NOW();
  const secret = `secret-${id}-${keySeq}`;
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, updatedAt, userId, keyHash, keyPrefix, planId)
     VALUES(?, ?, ?, NULL, 1, ?, ?, ?, ?, ?, ?)`,
    [id, secret, id, now, now, userId, hashApiKey(secret), secret.slice(0, 8), planId]
  );
  return secret;
}

const ONE_DOLLAR_REQUEST = { prompt_tokens: 1_000_000, completion_tokens: 0 };

function remaining(userPlanId) {
  return db.get(`SELECT creditRemainingNanoUsd AS c FROM userPlans WHERE id = ?`, [userPlanId]).c;
}

// ── 1. Key deleted mid-request ──────────────────────────────────────────────

test("a request that finishes after its key was deleted is still charged", async () => {
  plan("A"); user();
  const up = grant("A");
  const secret = key("k1");

  // Admitted, streaming… then the customer deletes the key.
  assert.equal(deleteApiKeySync(db, "k1"), true);
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM apiKeys`).n, 0);

  await saveRequestUsage({ provider: "test", model: "model-a", apiKey: secret, tokens: ONE_DOLLAR_REQUEST, endpoint: "/v1/chat/completions" });

  const row = db.get(`SELECT apiKeyId, apiKey, costNanoUsd FROM usageHistory`);
  assert.equal(row.apiKeyId, "k1", "the usage row is attributed to the deleted key");
  assert.equal(row.apiKey, null, "the raw secret is still not stored");
  assert.equal(row.costNanoUsd, USD(1));
  const charge = db.get(`SELECT userId, deltaNanoUsd FROM creditLedger WHERE kind = 'charge'`);
  assert.deepEqual({ ...charge }, { userId: "u1", deltaNanoUsd: -USD(1) });
  assert.equal(remaining(up), USD(9));
});

test("a deleted pinned key is still charged to its pinned plan only", async () => {
  plan("A"); plan("B"); user();
  const upA = grant("A", { usd: 100, priority: 1 });
  const upB = grant("B", { usd: 10, priority: 2 });
  const secret = key("kb", { planId: "B" });

  deleteApiKeySync(db, "kb");
  await saveRequestUsage({ provider: "test", model: "model-a", apiKey: secret, tokens: ONE_DOLLAR_REQUEST, endpoint: "/v1/chat/completions" });

  assert.equal(remaining(upB), USD(9), "the pinned plan pays");
  assert.equal(remaining(upA), USD(100), "the head of the queue is not touched");
});

test("deleting a customer key keeps only the owner and the key hash", () => {
  plan("A"); user();
  grant("A");
  const secret = key("k1", { planId: "A" });

  deleteApiKeySync(db, "k1");

  const rows = db.all(`SELECT * FROM deletedApiKeys`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].keyHash, hashApiKey(secret));
  assert.equal(rows[0].userId, "u1");
  assert.equal(rows[0].planId, "A");
  assert.ok(!JSON.stringify(rows).includes(secret), "the raw secret is never kept");
  assert.deepEqual(resolveApiKeyOwner(db, secret), { userId: "u1", apiKeyId: "k1", deleted: true, planId: "A", botId: null });
});

test("a key with only a plaintext column still leaves a tombstone", () => {
  user();
  const now = NOW();
  db.run(
    `INSERT INTO apiKeys(id, key, name, isActive, createdAt, userId) VALUES('legacy', 'secret-legacy-x', 'legacy', 1, ?, 'u1')`,
    [now]
  );
  deleteApiKeySync(db, "legacy");
  assert.equal(db.get(`SELECT keyHash FROM deletedApiKeys`).keyHash, hashApiKey("secret-legacy-x"));
});

test("deleting an admin key (no owner) leaves no tombstone and is never charged", async () => {
  const now = NOW();
  db.run(`INSERT INTO apiKeys(id, key, name, isActive, createdAt) VALUES('adm', 'secret-admin-x', 'adm', 1, ?)`, [now]);

  assert.equal(deleteApiKeySync(db, "adm"), true);
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM deletedApiKeys`).n, 0);
  assert.equal(resolveApiKeyOwner(db, "secret-admin-x"), null);
});

test("deleting a key that does not exist reports false", () => {
  assert.equal(deleteApiKeySync(db, "nope"), false);
});

test("tombstones past the retention window are pruned on the next delete", () => {
  user();
  const old = new Date(Date.now() - DELETED_KEY_RETENTION_MS - 60_000).toISOString();
  db.run(
    `INSERT INTO deletedApiKeys(keyHash, apiKeyId, userId, planId, deletedAt) VALUES('oldhash', 'kold', 'u1', NULL, ?)`,
    [old]
  );
  key("k1");
  deleteApiKeySync(db, "k1");

  const hashes = db.all(`SELECT apiKeyId FROM deletedApiKeys`).map((r) => r.apiKeyId);
  assert.deepEqual(hashes, ["k1"]);
});

// ── 2. Unmetered endpoints ─────────────────────────────────────────────────

test("a customer key is refused on endpoints that are not metered", () => {
  user();
  const secret = key("k1");
  assert.deepEqual(refuseUnmeteredSync(db, secret), {
    status: 403,
    code: "endpoint_not_available",
    message: UNMETERED_ENDPOINT_MESSAGE,
  });
});

test("admin keys and keyless local calls still reach unmetered endpoints", () => {
  const now = NOW();
  db.run(`INSERT INTO apiKeys(id, key, name, isActive, createdAt) VALUES('adm', 'secret-admin-y', 'adm', 1, ?)`, [now]);
  assert.equal(refuseUnmeteredSync(db, "secret-admin-y"), null);
  assert.equal(refuseUnmeteredSync(db, null), null);
  assert.equal(refuseUnmeteredSync(db, "sk-not-a-key"), null);
});

// ── 3. RPM/TPM survive a key rotation ───────────────────────────────────────

test("usage of a key deleted a moment ago still counts toward the user's RPM/TPM", async () => {
  const { getUserRateUsage } = await import("../src/lib/db/repos/usageRepo.js");
  plan("A"); user();
  grant("A");
  const secret = key("k1");
  // Different token counts: identical rows in one millisecond are deduplicated.
  await saveRequestUsage({ provider: "test", model: "model-a", apiKey: secret, tokens: { prompt_tokens: 5, completion_tokens: 5 }, endpoint: "/v1/chat/completions" });
  await saveRequestUsage({ provider: "test", model: "model-a", apiKey: secret, tokens: { prompt_tokens: 6, completion_tokens: 4 }, endpoint: "/v1/chat/completions" });

  assert.deepEqual(await getUserRateUsage("u1"), { requests: 2, tokens: 20 });
  deleteApiKeySync(db, "k1");
  key("k2"); // the replacement key
  assert.deepEqual(await getUserRateUsage("u1"), { requests: 2, tokens: 20 }, "deleting the key does not reset the minute");
});

test("a pinned key deleted after its owner was cached is still charged to the pinned plan", async () => {
  plan("A"); plan("B"); user();
  const upA = grant("A", { usd: 100, priority: 1 });
  const upB = grant("B", { usd: 10, priority: 2 });
  const secret = key("kb", { planId: "B" });

  // The first request of a burst finishes and fills the 60 s owner cache…
  await saveRequestUsage({ provider: "test", model: "model-a", apiKey: secret, tokens: ONE_DOLLAR_REQUEST, endpoint: "/v1/chat/completions" });
  // …then the key is deleted while the rest are still streaming.
  deleteApiKeySync(db, "kb");
  await saveRequestUsage({ provider: "test", model: "model-a", apiKey: secret, tokens: { prompt_tokens: 2_000_000, completion_tokens: 0 }, endpoint: "/v1/chat/completions" });

  assert.equal(remaining(upB), USD(7), "both requests are paid by the pinned plan");
  assert.equal(remaining(upA), USD(100));
});

test("a delete inside the caller's transaction (admin console) also leaves a tombstone", async () => {
  const { deleteApiKeyInTransactionSync } = await import("../src/lib/db/repos/apiKeysRepo.js");
  plan("A"); user();
  const up = grant("A");
  const secret = key("k1");

  let deleted = false;
  db.transaction(() => {
    deleted = deleteApiKeyInTransactionSync(db, "k1");
    db.run(`INSERT INTO users(id, email, passwordHash, status, overdraftNanoUsd, createdAt, updatedAt) VALUES('audit-proxy', 'a@x', 'x', 'active', 0, ?, ?)`, [NOW(), NOW()]);
  });
  assert.equal(deleted, true);
  await saveRequestUsage({ provider: "test", model: "model-a", apiKey: secret, tokens: ONE_DOLLAR_REQUEST, endpoint: "/v1/chat/completions" });
  assert.equal(remaining(up), USD(9));
});
