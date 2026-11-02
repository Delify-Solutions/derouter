import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";
import { stripDateSuffix } from "../../auth/modelMatching.js";

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

  if (!model) return none;

  // A dated id ("gpt-4o-2024-11-20") is also tried without its date. The model
  // allow-list already treats the two as the same model (modelMatching.js), so
  // pricing must too: otherwise the dated name fell through to a cheaper glob
  // ("gpt-4o-*", meant for gpt-4o-mini) and was charged a fraction of the price.
  // Each tier tries the exact id first, then the undated one.
  const ids = [model];
  const undated = stripDateSuffix(model);
  if (undated && undated !== model) ids.push(undated);

  // 2. User per-provider exact override.
  if (provider) {
    const userPricing = await getUserPricing();
    for (const id of ids) {
      if (userPricing[provider]?.[id]) return { pricing: userPricing[provider][id], source: "user" };
    }
  }

  const sse = await import("open-sse/providers/pricing.js");

  // 3. Built-in provider-specific override.
  if (provider) {
    for (const id of ids) {
      if (sse.PROVIDER_PRICING[provider]?.[id]) return { pricing: sse.PROVIDER_PRICING[provider][id], source: "provider" };
    }
  }

  // 4. Canonical model price ("deepseek/deepseek-chat" → "deepseek-chat").
  const bases = ids.map((id) => (id.includes("/") ? id.split("/").pop() : id));
  for (let i = 0; i < ids.length; i += 1) {
    if (sse.MODEL_PRICING[bases[i]]) return { pricing: sse.MODEL_PRICING[bases[i]], source: "model" };
    if (sse.MODEL_PRICING[ids[i]]) return { pricing: sse.MODEL_PRICING[ids[i]], source: "model" };
  }

  // 5. Glob pattern fallback — undated id first, for the reason above.
  for (let i = ids.length - 1; i >= 0; i -= 1) {
    for (const { pattern, pricing } of sse.PATTERN_PRICING) {
      if (sse.matchPattern(pattern, bases[i]) || sse.matchPattern(pattern, ids[i])) {
        return { pricing, source: "pattern" };
      }
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
