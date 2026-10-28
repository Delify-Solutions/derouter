import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";

const pricingKv = makeKv("pricing");
const CACHE_TTL_MS = 5000;

let cache = { value: null, expiresAt: 0 };

function invalidate() {
  cache = { value: null, expiresAt: 0 };
}

async function getUserPricing() {
  return await pricingKv.getAll();
}

export async function getPricing() {
  const now = Date.now();
  if (cache.value && cache.expiresAt > now) return cache.value;

  const userPricing = await getUserPricing();
  const { PROVIDER_PRICING } = await import("open-sse/providers/pricing.js");
  const merged = {};

  for (const [provider, models] of Object.entries(PROVIDER_PRICING)) {
    merged[provider] = { ...models };
    if (userPricing[provider]) {
      for (const [model, pricing] of Object.entries(userPricing[provider])) {
        merged[provider][model] = merged[provider][model]
          ? { ...merged[provider][model], ...pricing }
          : pricing;
      }
    }
  }

  for (const [provider, models] of Object.entries(userPricing)) {
    if (!merged[provider]) {
      merged[provider] = { ...models };
    } else {
      for (const [model, pricing] of Object.entries(models)) {
        if (!merged[provider][model]) merged[provider][model] = pricing;
      }
    }
  }

  cache = { value: merged, expiresAt: now + CACHE_TTL_MS };
  return merged;
}

export async function getPricingForModel(provider, model) {
  const { pricing } = await resolvePrice({ provider, model });
  return pricing;
}

/**
 * Single pricing-precedence chain for one request. Every money path must go
 * through here so combos, user overrides, provider rates, canonical models and
 * pattern fallbacks can never disagree.
 *
 * Precedence (first match wins):
 *   1. combo override — only when `requestedModel` is a bare name (no "/"),
 *      i.e. the client asked for a combo rather than provider/model.
 *   2. user per-provider exact override (pricing kv scope)
 *   3. built-in PROVIDER_PRICING[provider][model]
 *   4. MODEL_PRICING[baseModel] (vendor prefix stripped)
 *   5. PATTERN_PRICING glob match
 *
 * @param {{ provider?: string, model?: string, requestedModel?: string }} args
 * @returns {Promise<{ pricing: object|null, source: "combo"|"user"|"provider"|"model"|"pattern"|"none" }>}
 */
export async function resolvePrice({ provider, model, requestedModel } = {}) {
  const none = { pricing: null, source: "none" };

  // 1. Combo override: bare names only ("mygpt"), never "provider/model".
  if (requestedModel && !requestedModel.includes("/")) {
    const { getPricingForCombo } = await import("./comboPricingRepo.js");
    const comboPricing = await getPricingForCombo(requestedModel);
    if (comboPricing) return { pricing: comboPricing, source: "combo" };
  }

  // 2. User per-provider exact override.
  if (provider && model) {
    const userPricing = await getUserPricing();
    if (userPricing[provider]?.[model]) {
      return { pricing: userPricing[provider][model], source: "user" };
    }
  }

  const sse = await import("open-sse/providers/pricing.js");

  // 3. Built-in provider-specific override.
  if (provider && model && sse.PROVIDER_PRICING[provider]?.[model]) {
    return { pricing: sse.PROVIDER_PRICING[provider][model], source: "provider" };
  }

  if (!model) return none;

  // 4. Canonical model price ("deepseek/deepseek-chat" → "deepseek-chat").
  const baseModel = model.includes("/") ? model.split("/").pop() : model;
  if (sse.MODEL_PRICING[baseModel]) return { pricing: sse.MODEL_PRICING[baseModel], source: "model" };
  if (sse.MODEL_PRICING[model]) return { pricing: sse.MODEL_PRICING[model], source: "model" };

  // 5. Glob pattern fallback.
  for (const { pattern, pricing } of sse.PATTERN_PRICING) {
    if (sse.matchPattern(pattern, baseModel) || sse.matchPattern(pattern, model)) {
      return { pricing, source: "pattern" };
    }
  }

  return none;
}

// Atomic merge inside transaction (per-provider read-modify-write)
export async function updatePricing(pricingData) {
  const db = await getAdapter();
  db.transaction(() => {
    for (const [provider, models] of Object.entries(pricingData)) {
      const row = db.get(`SELECT value FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
      const current = row ? (parseJson(row.value, {}) || {}) : {};
      const merged = { ...current };
      for (const [model, pricing] of Object.entries(models)) {
        merged[model] = pricing;
      }
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [provider, stringifyJson(merged)]
      );
    }
  });
  invalidate();
  return await getUserPricing();
}

export async function resetPricing(provider, model) {
  if (!provider) return await getUserPricing();
  const db = await getAdapter();
  db.transaction(() => {
    if (!model) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
      return;
    }
    const row = db.get(`SELECT value FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
    const current = row ? (parseJson(row.value, {}) || {}) : {};
    delete current[model];
    if (Object.keys(current).length === 0) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
    } else {
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [provider, stringifyJson(current)]
      );
    }
  });
  invalidate();
  return await getUserPricing();
}

export async function resetAllPricing() {
  await pricingKv.clear();
  invalidate();
  return {};
}
