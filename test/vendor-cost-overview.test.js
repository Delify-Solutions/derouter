// Overview profit/loss summary (spec admin-usage-views "Overview profit and loss
// summary"): a day with every request priced, some priced, none priced, and a period
// spanning a priced and an unpriced day — summary and per-bucket figures must be
// NULL-aware throughout (pricedRequests === 0 never reads as "profit is zero").
// Relative imports only: plain `node --test` cannot resolve the `@/` alias.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-vendor-cost-overview-test-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const { saveRequestUsage, getUsageStats } = await import("../src/lib/db/repos/usageRepo.js");
const { updatePricing, resetAllPricing } = await import("../src/lib/db/repos/pricingRepo.js");
const { updateVendorCost, resetAllVendorCost } = await import("../src/lib/db/repos/vendorCostRepo.js");

let db;

before(async () => { db = await getAdapter(); });
after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(async () => {
  for (const table of ["usageHistory", "usageDaily", "kv"]) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* table may not exist */ }
  }
  await resetAllPricing();
  await resetAllVendorCost();
  await updatePricing({ openrouter: { "glm-5": { input: 2, output: 0 } } });
});

const todayIso = (hour = 10) => {
  const d = new Date();
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};
const yesterdayIso = (hour = 10) => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

async function logRequest(ts, promptTokens = 1_000_000) {
  return await saveRequestUsage({
    provider: "openrouter", model: "glm-5", timestamp: ts,
    tokens: { prompt_tokens: promptTokens, completion_tokens: 0 },
  });
}

test("a day with every request priced: full figures, no partial note", async () => {
  await updateVendorCost({ openrouter: { "glm-5": { rate: { input: 1, output: 0 } } } });
  await logRequest(todayIso(9));
  await logRequest(todayIso(10));

  const stats = await getUsageStats("7d", { modelView: "upstream" });
  assert.equal(stats.totalRequests, 2);
  assert.equal(stats.totalPricedRequests, 2);
  assert.equal(stats.totalVendorCostNanoUsd, 2_000_000_000); // 2 x $1
  assert.equal(stats.totalCostNanoUsd, 4_000_000_000); // 2 x $2 sell price

  const modelRow = Object.values(stats.byModel)[0];
  assert.equal(modelRow.requests, 2);
  assert.equal(modelRow.pricedRequests, 2);
  assert.equal(modelRow.vendorCostNanoUsd, 2_000_000_000);
});

test("a day with some requests priced: partial pricedRequests, never zero profit", async () => {
  await updateVendorCost({ openrouter: { "glm-5": { rate: { input: 1, output: 0 } } } });
  await logRequest(todayIso(9));
  // Clear the vendor cost before the second request: it will have none.
  await resetAllVendorCost();
  await logRequest(todayIso(11));

  const stats = await getUsageStats("7d", { modelView: "upstream" });
  assert.equal(stats.totalRequests, 2);
  assert.equal(stats.totalPricedRequests, 1);
  assert.equal(stats.totalVendorCostNanoUsd, 1_000_000_000);

  const modelRow = Object.values(stats.byModel)[0];
  assert.equal(modelRow.requests, 2);
  assert.equal(modelRow.pricedRequests, 1);
});

test("a day with none priced: pricedRequests 0, vendor cost 0 — reads as no data", async () => {
  await logRequest(todayIso(9));
  await logRequest(todayIso(10));

  const stats = await getUsageStats("7d", { modelView: "upstream" });
  assert.equal(stats.totalRequests, 2);
  assert.equal(stats.totalPricedRequests, 0);
  assert.equal(stats.totalVendorCostNanoUsd, 0);
});

test("a period spanning a priced day and an unpriced day: period totals reflect both", async () => {
  // Yesterday: priced.
  await updateVendorCost({ openrouter: { "glm-5": { rate: { input: 1, output: 0 } } } });
  await logRequest(yesterdayIso(9));
  // Today: vendor cost cleared, unpriced.
  await resetAllVendorCost();
  await logRequest(todayIso(9));

  const stats = await getUsageStats("7d", { modelView: "upstream" });
  assert.equal(stats.totalRequests, 2);
  assert.equal(stats.totalPricedRequests, 1);
  assert.equal(stats.totalVendorCostNanoUsd, 1_000_000_000);
});
