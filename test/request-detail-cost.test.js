// saveUsageStats (open-sse/handlers/chatCore/requestDetail.js) is a thin wrapper
// around saveRequestUsage: this confirms it actually forwards that call's result
// ({ costNanoUsd, chargedNanoUsd }) rather than swallowing it, since the 4 handler
// call sites (nonStreamingHandler/streamingHandler/sseToJsonHandler) all depend on
// that return value to give their requestDetails row the real figures.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

register("./helpers/src-alias-hook.mjs", import.meta.url);
register("./helpers/next-server-hook.mjs", import.meta.url);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-reqdetail-cost-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const { updatePricing } = await import("../src/lib/db/repos/pricingRepo.js");
const { hashApiKey } = await import("../src/lib/db/repos/apiKeysRepo.js");
const { saveUsageStats } = await import("../open-sse/handlers/chatCore/requestDetail.js");
const { NANO } = await import("../src/shared/utils/money.js");

let db;
const USD = (n) => Math.round(n * NANO);
const NOW = () => new Date().toISOString();
const inDays = (d) => new Date(Date.now() + d * 86_400_000).toISOString();

before(async () => {
  db = await getAdapter();
  // $1 per 1M input tokens, so 1M prompt tokens costs exactly $1.
  await updatePricing({ test: { "model-a": { input: 1, output: 1 } } });
});

after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  for (const table of ["usageHistory", "creditLedger", "userPlanWindows", "userPlans", "apiKeys", "users", "plans"]) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* partial schema */ }
  }
});

function user(id = "u1") {
  const now = NOW();
  db.run(
    `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
     VALUES(?, ?, 'x', NULL, NULL, 'active', 0, ?, ?)`,
    [id, `${id}@test.local`, now, now]
  );
}

function key(id, { userId = "u1" } = {}) {
  const now = NOW();
  const secret = `secret-${id}`;
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, updatedAt, userId, keyHash, keyPrefix, planId)
     VALUES(?, ?, ?, NULL, 1, ?, ?, ?, ?, ?, NULL)`,
    [id, secret, id, now, now, userId, hashApiKey(secret), secret.slice(0, 8)]
  );
  return secret;
}

const ONE_DOLLAR = { prompt_tokens: 1_000_000, completion_tokens: 0 };

test("saveUsageStats forwards saveRequestUsage's real cost/charged figures", async () => {
  user();
  db.run(
    `INSERT INTO userPlans(id, userId, planId, orderId, source, creditTotalNanoUsd, creditRemainingNanoUsd, startsAt, expiresAt, status, createdAt)
     VALUES('up1', 'u1', NULL, NULL, 'admin', ?, ?, ?, ?, 'active', ?)`,
    [USD(10), USD(10), NOW(), inDays(30), NOW()]
  );
  const secret = key("k1");

  const result = await saveUsageStats({ provider: "test", model: "model-a", tokens: ONE_DOLLAR, apiKey: secret });
  assert.equal(result.costNanoUsd, USD(1));
  assert.equal(result.chargedNanoUsd, USD(1));
});

test("saveUsageStats resolves null, not throws, when there is nothing to record", async () => {
  assert.equal(await saveUsageStats({ provider: "test", model: "model-a", tokens: { prompt_tokens: 0, completion_tokens: 0 } }), null);
  assert.equal(await saveUsageStats({ provider: "test", model: "model-a", tokens: null }), null);
});

test("costNanoUsd/chargedNanoUsd round-trip through saveRequestDetail/getRequestDetails, null when never set", async () => {
  const { updateSettings } = await import("../src/lib/db/repos/settingsRepo.js");
  const { saveRequestDetail, getRequestDetails } = await import("../src/lib/db/repos/requestDetailsRepo.js");
  delete process.env.ENABLE_REQUEST_LOGS;
  await updateSettings({ enableObservability: true, observabilityBatchSize: 1 });

  await saveRequestDetail({ id: "d-priced", provider: "p", model: "m", status: "200", costNanoUsd: USD(1), chargedNanoUsd: USD(1) });
  await saveRequestDetail({ id: "d-unlimited", provider: "p", model: "m", status: "200", costNanoUsd: USD(2), chargedNanoUsd: 0 });
  await saveRequestDetail({ id: "d-legacy", provider: "p", model: "m", status: "200" });

  for (let i = 0; i < 100 && !db.get(`SELECT 1 AS x FROM requestDetails WHERE id = 'd-legacy'`); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const { details } = await getRequestDetails({ page: 1, pageSize: 20 });
  const byId = Object.fromEntries(details.map((d) => [d.id, d]));
  assert.equal(byId["d-priced"].costNanoUsd, USD(1));
  assert.equal(byId["d-priced"].chargedNanoUsd, USD(1));
  assert.equal(byId["d-unlimited"].costNanoUsd, USD(2));
  assert.equal(byId["d-unlimited"].chargedNanoUsd, 0, "fully covered by an unlimited plan: 0, not null");
  assert.equal(byId["d-legacy"].costNanoUsd, null, "never set: null, not 0 — nothing to show as free");
  assert.equal(byId["d-legacy"].chargedNanoUsd, null);
});
