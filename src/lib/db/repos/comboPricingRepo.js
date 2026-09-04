import { makeKv } from "../helpers/kvStore.js";

// Combo-level pricing overrides. Stored in the kv table under scope "comboPricing",
// keyed by combo name, value = { input, output, cached, reasoning, cache_creation } ($/1M tokens).
// Mirrors pricingRepo.js but flat (combo name -> pricing) instead of provider -> model -> pricing.
//
// Cost resolution order (see usageRepo.calculateCost):
//   1. If the request was for a combo name and a combo price is set here → use it.
//   2. Otherwise fall back to per-pool pricing (pricingRepo.getPricingForModel).

const comboKv = makeKv("comboPricing");
const CACHE_TTL_MS = 5000;

let cache = { value: null, expiresAt: 0 };

function invalidate() {
  cache = { value: null, expiresAt: 0 };
}

// All combo price overrides: { comboName: { input, output, cached, reasoning, cache_creation } }
export async function getComboPricing() {
  const now = Date.now();
  if (cache.value && cache.expiresAt > now) return cache.value;
  const all = await comboKv.getAll();
  cache = { value: all, expiresAt: now + CACHE_TTL_MS };
  return all;
}

// Price for a single combo name, or null if not set.
export async function getPricingForCombo(comboName) {
  if (!comboName) return null;
  const all = await getComboPricing();
  return all[comboName] || null;
}

// pricingData: { comboName: { input, output, cached, reasoning, cache_creation } }
// (validates keys; numeric fields only, non-negative)
const VALID_FIELDS = ["input", "output", "cached", "reasoning", "cache_creation"];

export async function updateComboPricing(pricingData) {
  const cleaned = {};
  for (const [comboName, pricing] of Object.entries(pricingData || {})) {
    if (!comboName) continue;
    const entry = {};
    for (const field of VALID_FIELDS) {
      const v = pricing?.[field];
      entry[field] = typeof v === "number" && v >= 0 ? v : 0;
    }
    cleaned[comboName] = entry;
  }
  await comboKv.setMany(cleaned);
  invalidate();
  return await getComboPricing();
}

// Reset a single combo's price (or all if name omitted).
export async function resetComboPricing(comboName) {
  if (!comboName) return await resetAllComboPricing();
  await comboKv.remove(comboName);
  invalidate();
  return await getComboPricing();
}

export async function resetAllComboPricing() {
  await comboKv.clear();
  invalidate();
  return {};
}
