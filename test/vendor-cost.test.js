// Vendor-cost pricing (spec vendor-cost-pricing): resolution precedence, on/off-peak
// schedule, and the per-request snapshot never changing after a later price edit.
// Relative imports only: plain `node --test` cannot resolve the `@/` alias.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-vendor-cost-test-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const {
  resolveVendorCost, calculateVendorCostNano, updateVendorCost, resetAllVendorCost, isOffPeak,
} = await import("../src/lib/db/repos/vendorCostRepo.js");
const { saveRequestUsage } = await import("../src/lib/db/repos/usageRepo.js");
const { updatePricing, resetAllPricing } = await import("../src/lib/db/repos/pricingRepo.js");

let db;

before(async () => { db = await getAdapter(); });
after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(async () => {
  for (const table of ["usageHistory", "kv"]) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* table may not exist */ }
  }
  await resetAllVendorCost();
  await resetAllPricing();
});

// Asia/Ho_Chi_Minh is UTC+7 year-round (no DST), so a fixed UTC offset is exact here.
const vnTime = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  const utcH = (h - 7 + 24) % 24;
  return new Date(Date.UTC(2026, 0, 15, utcH, m, 0)).getTime();
};

test("flat rate applies at every hour", async () => {
  await updateVendorCost({ openrouter: { "glm-5": { rate: { input: 1, output: 3 } } } });
  const rate = await resolveVendorCost({ provider: "openrouter", model: "glm-5", atMs: vnTime("14:00") });
  assert.deepEqual(rate, { input: 1, output: 3 });
  const rateNight = await resolveVendorCost({ provider: "openrouter", model: "glm-5", atMs: vnTime("03:00") });
  assert.deepEqual(rateNight, { input: 1, output: 3 });
});

test("on-peak rate used outside the off-peak window", async () => {
  await updateVendorCost({
    openrouter: {
      "glm-5": {
        rate: { input: 1, output: 3 },
        offPeak: { rate: { input: 0.5, output: 1.5 }, start: "00:00", end: "06:00" },
      },
    },
  });
  const rate = await resolveVendorCost({ provider: "openrouter", model: "glm-5", atMs: vnTime("14:00") });
  assert.deepEqual(rate, { input: 1, output: 3 });
});

test("off-peak rate used inside the window", async () => {
  await updateVendorCost({
    openrouter: {
      "glm-5": {
        rate: { input: 1, output: 3 },
        offPeak: { rate: { input: 0.5, output: 1.5 }, start: "00:00", end: "06:00" },
      },
    },
  });
  const rate = await resolveVendorCost({ provider: "openrouter", model: "glm-5", atMs: vnTime("03:00") });
  assert.deepEqual(rate, { input: 0.5, output: 1.5 });
});

test("off-peak window wraps past midnight", async () => {
  await updateVendorCost({
    openrouter: {
      "glm-5": {
        rate: { input: 1, output: 3 },
        offPeak: { rate: { input: 0.5, output: 1.5 }, start: "22:00", end: "06:00" },
      },
    },
  });
  // Inside the wrapped window on both sides of midnight.
  assert.deepEqual(await resolveVendorCost({ provider: "openrouter", model: "glm-5", atMs: vnTime("23:30") }), { input: 0.5, output: 1.5 });
  assert.deepEqual(await resolveVendorCost({ provider: "openrouter", model: "glm-5", atMs: vnTime("02:00") }), { input: 0.5, output: 1.5 });
  // Outside it.
  assert.deepEqual(await resolveVendorCost({ provider: "openrouter", model: "glm-5", atMs: vnTime("14:00") }), { input: 1, output: 3 });
});

test("boundary times: exactly at start is off-peak, exactly at end is on-peak", async () => {
  assert.equal(isOffPeak("22:00", "22:00", "06:00"), true);
  assert.equal(isOffPeak("06:00", "22:00", "06:00"), false);
  assert.equal(isOffPeak("00:00", "00:00", "06:00"), true);
  assert.equal(isOffPeak("06:00", "00:00", "06:00"), false);
});

test("unset (provider, model) pair resolves to null, never zero", async () => {
  const rate = await resolveVendorCost({ provider: "zai", model: "glm-5.3:pre", atMs: Date.now() });
  assert.equal(rate, null);
  const nano = await calculateVendorCostNano("zai", "glm-5.3:pre", { prompt_tokens: 100, completion_tokens: 50 }, 0, Date.now());
  assert.equal(nano, null);
});

test("calculateVendorCostNano prices tokens the same way customer billing does", async () => {
  await updateVendorCost({ openrouter: { "glm-5": { rate: { input: 1, output: 3 } } } });
  const nano = await calculateVendorCostNano(
    "openrouter", "glm-5",
    { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
    0, vnTime("14:00")
  );
  // 1,000,000 input @ $1/1M + 1,000,000 output @ $3/1M = $4 = 4e9 nano.
  assert.equal(nano, 4_000_000_000);
});

test("snapshot is stable after a later vendor-cost edit — stored on the usageHistory row", async () => {
  await updateVendorCost({ openrouter: { "glm-5": { rate: { input: 1, output: 0 } } } });
  // Seed a sell price too, so cost computation is realistic (cost silently becomes 0
  // in tests otherwise, per project convention).
  await updatePricing({ openrouter: { "glm-5": { input: 2, output: 0 } } });

  const ts = new Date(vnTime("14:00")).toISOString();
  const result = await saveRequestUsage({
    provider: "openrouter", model: "glm-5", timestamp: ts,
    tokens: { prompt_tokens: 1_000_000, completion_tokens: 0 },
  });
  assert.equal(result.vendorCostNanoUsd, 1_000_000_000); // $1 @ $1/1M input

  // Admin changes the vendor cost rate AFTER the request was logged.
  await updateVendorCost({ openrouter: { "glm-5": { rate: { input: 2, output: 0 } } } });

  const row = db.get(`SELECT vendorCostNanoUsd FROM usageHistory WHERE provider = 'openrouter' AND model = 'glm-5'`);
  assert.equal(row.vendorCostNanoUsd, 1_000_000_000, "stored snapshot must not move with the later edit");

  // And a fresh resolution for a NEW request reflects the new rate.
  const nano = await calculateVendorCostNano("openrouter", "glm-5", { prompt_tokens: 1_000_000, completion_tokens: 0 }, 0, Date.now());
  assert.equal(nano, 2_000_000_000);
});

test("a request logged with no matching vendor-cost record stores NULL, not 0", async () => {
  await updatePricing({ openrouter: { "glm-5": { input: 2, output: 0 } } });
  const ts = new Date(vnTime("14:00")).toISOString();
  const result = await saveRequestUsage({
    provider: "openrouter", model: "glm-5", timestamp: ts,
    tokens: { prompt_tokens: 1000, completion_tokens: 0 },
  });
  assert.equal(result.vendorCostNanoUsd, null);
  const row = db.get(`SELECT vendorCostNanoUsd FROM usageHistory WHERE provider = 'openrouter' AND model = 'glm-5'`);
  assert.equal(row.vendorCostNanoUsd, null);
});
