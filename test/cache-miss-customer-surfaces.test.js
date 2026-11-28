// Customer-facing cache-miss surfaces (change cache-miss-auto-refund, capability
// cache-miss-refund "Customer visibility" + customer-portal spec deltas), tested at
// the repo layer against a real throwaway SQLite database — same convention as
// test/account-plans.test.js.
//
//   * /account/usage marks a flagged row (usageRepo.getUsageHistory's usageHistoryId
//     joined against cacheMissRepo.listFlaggedUsageHistoryIds)
//   * /account/cache-refunds lists only resolved (auto_refunded/approved) refunds,
//     newest first, and is empty when there are none
//   * no internal-cause field (connectionId, or any rotation/pool wording) ever
//     appears in what these repo functions return for customer-facing display
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-cache-miss-customer-test-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const { getUsageHistory } = await import("../src/lib/db/repos/usageRepo.js");
const {
  insertCacheMissDetectionSync,
  listFlaggedUsageHistoryIds,
  listCustomerCacheMissRefunds,
} = await import("../src/lib/db/repos/cacheMissRepo.js");
const { NANO } = await import("../src/shared/utils/money.js");

let db;
const USD = (n) => Math.round(n * NANO);

async function reset() {
  for (const t of ["cacheMissDetections", "usageHistory", "apiKeys", "users"]) {
    try { db.run(`DELETE FROM ${t}`); } catch { /* table may not exist on a partial schema */ }
  }
}

function insertUser(id) {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
     VALUES(?, ?, 'x', 'T', NULL, 'active', 0, ?, ?)`,
    [id, `${id}@test.local`, now, now]
  );
}

function insertApiKey(id, userId) {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO apiKeys(id, key, name, isActive, createdAt, userId) VALUES(?, ?, 'k', 1, ?, ?)`,
    [id, `raw-${id}`, now, userId]
  );
}

function insertUsageRow({ apiKey, apiKeyId }) {
  const now = new Date().toISOString();
  const result = db.run(
    `INSERT INTO usageHistory(timestamp, provider, model, apiKey, apiKeyId, promptTokens, completionTokens, costNanoUsd, status, tokens, meta)
     VALUES(?, 'test-provider', 'test-model', ?, ?, 1000, 100, ?, 'ok', '{}', '{}')`,
    [now, apiKey, apiKeyId, USD(1)]
  );
  return result.lastInsertRowid;
}

before(async () => { db = await getAdapter(); });

after(() => {
  try { db?.close?.(); } catch { /* adapters differ */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("/account/usage: a flagged request's usageHistoryId is marked", async () => {
  await reset();
  insertUser("u-flag");
  insertApiKey("k-flag", "u-flag");
  const flaggedId = insertUsageRow({ apiKey: "raw-k-flag", apiKeyId: "k-flag" });
  const notFlaggedId = insertUsageRow({ apiKey: "raw-k-flag", apiKeyId: "k-flag" });

  db.transaction(() =>
    insertCacheMissDetectionSync(db, {
      usageHistoryId: flaggedId, userId: "u-flag", apiKeyId: "k-flag",
      provider: "test-provider", model: "test-model", overlapTokens: 900, refundNanoUsd: USD(0.1),
    })
  );

  const rows = await getUsageHistory({ apiKey: "raw-k-flag" });
  const byId = new Map(rows.map((r) => [r.usageHistoryId, r]));
  assert.ok(byId.has(flaggedId));
  assert.ok(byId.has(notFlaggedId));

  const flagged = await listFlaggedUsageHistoryIds("u-flag");
  assert.ok(flagged.has(flaggedId), "the flagged request's id must be in the set");
  assert.ok(!flagged.has(notFlaggedId), "an unflagged request must not be in the set");
});

test("/account/cache-refunds: only resolved refunds are listed, newest first", async () => {
  await reset();
  insertUser("u-refunds");
  const idPending = `d-${Math.random()}`;
  const u1 = insertUsageRow({ apiKey: "raw-x", apiKeyId: null });
  const u2 = insertUsageRow({ apiKey: "raw-x", apiKeyId: null });
  const u3 = insertUsageRow({ apiKey: "raw-x", apiKeyId: null });

  const older = db.transaction(() =>
    insertCacheMissDetectionSync(db, {
      usageHistoryId: u1, userId: "u-refunds", provider: "p", model: "m", overlapTokens: 100, refundNanoUsd: USD(1),
    })
  );
  const newer = db.transaction(() =>
    insertCacheMissDetectionSync(db, {
      usageHistoryId: u2, userId: "u-refunds", provider: "p", model: "m", overlapTokens: 100, refundNanoUsd: USD(2),
    })
  );
  const stillPending = db.transaction(() =>
    insertCacheMissDetectionSync(db, {
      usageHistoryId: u3, userId: "u-refunds", provider: "p", model: "m", overlapTokens: 100, refundNanoUsd: USD(3),
    })
  );

  db.run(`UPDATE cacheMissDetections SET status = 'auto_refunded', resolvedAt = '2026-01-01T00:00:00.000Z' WHERE id = ?`, [older]);
  db.run(`UPDATE cacheMissDetections SET status = 'approved', resolvedAt = '2026-01-02T00:00:00.000Z' WHERE id = ?`, [newer]);
  // `stillPending` is left pending on purpose — it must never appear in the
  // customer's refunds list (it has not been refunded yet).

  const entries = await listCustomerCacheMissRefunds("u-refunds");
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, newer, "newest resolved refund first");
  assert.equal(entries[1].id, older);
  assert.ok(!entries.some((e) => e.id === stillPending), "a still-pending detection is not a refund yet");
});

test("/account/cache-refunds: empty when the customer has no refunds", async () => {
  await reset();
  insertUser("u-empty");
  const entries = await listCustomerCacheMissRefunds("u-empty");
  assert.deepEqual(entries, []);
});

test("no internal-cause field (connectionId, rotation/pool wording) in a customer-facing row", async () => {
  await reset();
  insertUser("u-leak");
  const u1 = insertUsageRow({ apiKey: "raw-y", apiKeyId: null });
  const id = db.transaction(() =>
    insertCacheMissDetectionSync(db, {
      usageHistoryId: u1, userId: "u-leak", provider: "p", model: "m", overlapTokens: 100, refundNanoUsd: USD(1),
    })
  );
  db.run(`UPDATE cacheMissDetections SET status = 'auto_refunded', resolvedAt = '2026-01-01T00:00:00.000Z' WHERE id = ?`, [id]);

  const entries = await listCustomerCacheMissRefunds("u-leak");
  assert.equal(entries.length, 1);
  const serialized = JSON.stringify(entries[0]).toLowerCase();
  for (const forbidden of ["connectionid", "rotation", "pool", "xoay"]) {
    assert.ok(!serialized.includes(forbidden), `customer-facing row must not mention "${forbidden}"`);
  }
});
