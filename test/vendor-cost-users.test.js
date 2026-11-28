// Usage -> Users: "Đã dùng thực (giá vốn)" column (spec admin-usage-views "Users
// vendor-cost column"). Tests getUsageByOwner (backing /api/usage/user-summary)
// directly, with useRollup: false so the raw-row path is exercised without waiting
// for the background hourly rollup.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-vendor-cost-users-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const { getUsageByOwner } = await import("../src/lib/db/repos/usageRepo.js");
const { hashApiKey } = await import("../src/lib/db/repos/apiKeysRepo.js");

let db;
const NOW = () => new Date().toISOString();

before(async () => { db = await getAdapter(); });
after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(async () => {
  for (const table of ["usageHistory", "apiKeys", "users"]) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* table may not exist */ }
  }
});

function user(id, email) {
  const now = NOW();
  db.run(
    `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
     VALUES(?, ?, 'x', NULL, NULL, 'active', 0, ?, ?)`,
    [id, email, now, now]
  );
}

function key(id, userId) {
  const now = NOW();
  const secret = `secret-${id}`;
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, updatedAt, userId, keyHash, keyPrefix, planId)
     VALUES(?, ?, ?, NULL, 1, ?, ?, ?, ?, ?, NULL)`,
    [id, secret, id, now, now, userId, hashApiKey(secret), secret.slice(0, 8)]
  );
  return secret;
}

function usageRow(apiKeyId, vendorCostNanoUsd) {
  db.run(
    `INSERT INTO usageHistory(timestamp, provider, model, apiKeyId, promptTokens, completionTokens, costNanoUsd, status, tokens, vendorCostNanoUsd)
     VALUES(?, 'p', 'm', ?, 1000, 0, 2000, 'ok', '{}', ?)`,
    [NOW(), apiKeyId, vendorCostNanoUsd]
  );
}

test("a customer with fully priced usage: vendorCostNanoUsd sums every request", async () => {
  user("u-full", "full@x.vn");
  key("k-full", "u-full");
  usageRow("k-full", 100_000);
  usageRow("k-full", 200_000);

  const items = await getUsageByOwner({ useRollup: false });
  const o = items.find((it) => it.userId === "u-full");
  assert.equal(o.totals.requests, 2);
  assert.equal(o.totals.pricedRequests, 2);
  assert.equal(o.totals.vendorCostNanoUsd, 300_000);
});

test("a customer with partially priced usage: pricedRequests < requests", async () => {
  user("u-partial", "partial@x.vn");
  key("k-partial", "u-partial");
  for (let i = 0; i < 4; i += 1) usageRow("k-partial", 50_000);
  for (let i = 0; i < 6; i += 1) usageRow("k-partial", null);

  const items = await getUsageByOwner({ useRollup: false });
  const o = items.find((it) => it.userId === "u-partial");
  assert.equal(o.totals.requests, 10);
  assert.equal(o.totals.pricedRequests, 4);
  assert.equal(o.totals.vendorCostNanoUsd, 200_000);
});

test("a customer with no priced usage: pricedRequests 0, shown as — by the UI", async () => {
  user("u-none", "none@x.vn");
  key("k-none", "u-none");
  usageRow("k-none", null);
  usageRow("k-none", null);

  const items = await getUsageByOwner({ useRollup: false });
  const o = items.find((it) => it.userId === "u-none");
  assert.equal(o.totals.requests, 2);
  assert.equal(o.totals.pricedRequests, 0);
  assert.equal(o.totals.vendorCostNanoUsd, 0);
});
