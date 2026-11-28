// Admin-only vendor (upstream) cost price per (provider, model) — spec
// vendor-cost-pricing. Stored exactly like pricingRepo.js's sell-price overrides (same
// `kv` table, same merge-on-write pattern, same 5s read cache), under a SEPARATE scope
// ("vendorCost") so the two can never be confused. NEVER read by pricingRepo.resolvePrice,
// combo pricing, discounts, or anything that computes a customer's chargedNanoUsd.
//
// A vendor-cost record:
//   {
//     rate: { input, output, cached, reasoning, cache_creation },   // on-peak, or the only
//                                                                   // rate if flat
//     offPeak: {                                                   // present only when
//       rate: { input, output, cached, reasoning, cache_creation }, // peak-aware
//       start: "HH:MM", end: "HH:MM"                                // Asia/Ho_Chi_Minh,
//     } | undefined                                                 // wraps past midnight
//   }
// No record for a (provider, model) pair ⇒ no vendor cost: represented as `null`, never `{}`.
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";
import { stripDateSuffix } from "../../auth/modelMatching.js";
import { costFromTokensNano, costFromImagesNano } from "../../../shared/utils/money.js";

const vendorCostKv = makeKv("vendorCost");
const CACHE_TTL_MS = 5000;
const TIME_ZONE = "Asia/Ho_Chi_Minh";

let cache = { value: null, expiresAt: 0 };

function invalidate() {
  cache = { value: null, expiresAt: 0 };
}

/** Whole vendor-cost map: { provider: { model: record } }. No built-in defaults layer —
 * unlike pricingRepo, there is nothing to fall back to: an unset pair is genuinely unknown. */
export async function getVendorCost() {
  const now = Date.now();
  if (cache.value && cache.expiresAt > now) return cache.value;
  const db = await getAdapter();
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = 'vendorCost'`);
  const out = {};
  for (const r of rows) out[r.key] = parseJson(r.value, {});
  cache = { value: out, expiresAt: now + CACHE_TTL_MS };
  return out;
}

/** The raw vendor-cost record for one exact (provider, model) pair, or null if unset. */
export async function getVendorCostForModel(provider, model) {
  if (!provider || !model) return null;
  const all = await getVendorCost();
  return all[provider]?.[model] ?? null;
}

// Atomic merge inside transaction (per-provider read-modify-write), same shape as
// pricingRepo.updatePricing: `vendorCostData` is { provider: { model: record } }.
export async function updateVendorCost(vendorCostData) {
  const db = await getAdapter();
  db.transaction(() => {
    for (const [provider, models] of Object.entries(vendorCostData)) {
      const row = db.get(`SELECT value FROM kv WHERE scope = 'vendorCost' AND key = ?`, [provider]);
      const current = row ? (parseJson(row.value, {}) || {}) : {};
      const merged = { ...current };
      for (const [model, record] of Object.entries(models)) {
        merged[model] = record;
      }
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('vendorCost', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [provider, stringifyJson(merged)]
      );
    }
  });
  invalidate();
  return await getVendorCost();
}

/** Set (or replace) the vendor-cost record for exactly one (provider, model) pair. */
export async function setVendorCostForModel(provider, model, record) {
  if (!provider || !model) throw new Error("provider and model are required");
  return await updateVendorCost({ [provider]: { [model]: record } });
}

export async function resetVendorCost(provider, model) {
  if (!provider) return await getVendorCost();
  const db = await getAdapter();
  db.transaction(() => {
    if (!model) {
      db.run(`DELETE FROM kv WHERE scope = 'vendorCost' AND key = ?`, [provider]);
      return;
    }
    const row = db.get(`SELECT value FROM kv WHERE scope = 'vendorCost' AND key = ?`, [provider]);
    const current = row ? (parseJson(row.value, {}) || {}) : {};
    delete current[model];
    if (Object.keys(current).length === 0) {
      db.run(`DELETE FROM kv WHERE scope = 'vendorCost' AND key = ?`, [provider]);
    } else {
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('vendorCost', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [provider, stringifyJson(current)]
      );
    }
  });
  invalidate();
  return await getVendorCost();
}

export async function resetAllVendorCost() {
  await vendorCostKv.clear();
  invalidate();
  return {};
}

// ─── resolution (mirrors pricingRepo.resolvePrice step 2 — exact match only) ────────────

/** "HH:MM" of `atMs` in Asia/Ho_Chi_Minh, e.g. "03:00" or "23:30". */
function localHHMM(atMs) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(atMs));
  const hh = parts.find((p) => p.type === "hour")?.value ?? "00";
  const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
  // Intl can format midnight as "24:00" in some environments; normalize to "00:00".
  return `${hh === "24" ? "00" : hh}:${mm}`;
}

/**
 * Is `hhmm` inside the off-peak window [start, end)? Wraps past midnight when
 * start > end (e.g. 22:00–06:00 ⇒ off-peak is [22:00,24:00) ∪ [00:00,06:00)).
 * Exactly `start` is off-peak; exactly `end` is on-peak.
 */
export function isOffPeak(hhmm, start, end) {
  if (!start || !end) return false;
  if (start === end) return false; // a zero-width / full-day window is never meaningfully off-peak
  if (start < end) return hhmm >= start && hhmm < end;
  // Wraps midnight.
  return hhmm >= start || hhmm < end;
}

/**
 * Resolve the vendor-cost rate for one (provider, model) pair at a point in time.
 * Exact-match only, date-suffix tolerant like resolvePrice step 2 — no combo, no
 * MODEL_PRICING, no glob fallback. Returns `null` when nothing matches.
 *
 * @param {{ provider?: string, model?: string, atMs?: number }} args
 * @returns {Promise<object|null>} the rate object to price this request with
 */
export async function resolveVendorCost({ provider, model, atMs = Date.now() } = {}) {
  if (!provider || !model) return null;
  const all = await getVendorCost();
  const byModel = all[provider];
  if (!byModel) return null;

  const ids = [model];
  const undated = stripDateSuffix(model);
  if (undated && undated !== model) ids.push(undated);

  let record = null;
  for (const id of ids) {
    if (byModel[id]) { record = byModel[id]; break; }
  }
  if (!record || !record.rate) return null;

  if (!record.offPeak) return record.rate;

  const hhmm = localHHMM(atMs);
  const { start, end } = record.offPeak;
  return isOffPeak(hhmm, start, end) ? (record.offPeak.rate || record.rate) : record.rate;
}

/**
 * Vendor cost of one request as integer nanoUSD, or `null` when no vendor-cost record
 * matches the (provider, model) pair at `atMs`. Reuses the exact same pure cost math as
 * customer billing (costFromTokensNano / costFromImagesNano) against whichever rate
 * resolveVendorCost picks — never a second pricing formula.
 */
export async function calculateVendorCostNano(provider, model, tokens, imageCount = 0, atMs = Date.now()) {
  if (!tokens && !(imageCount > 0)) return null;
  try {
    const rate = await resolveVendorCost({ provider, model, atMs });
    if (!rate) return null;
    if (imageCount > 0) return costFromImagesNano(imageCount, rate);
    return costFromTokensNano(tokens, rate);
  } catch (e) {
    console.error("[vendorCostRepo] calculateVendorCostNano failed:", e.message);
    return null;
  }
}
