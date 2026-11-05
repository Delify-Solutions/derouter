// The per-model price list customers see (change models-notifications, D2):
// combos with their per-1M-token prices, plus the discounts in force and their
// reasons. One builder for the public usage page and the account model page, so
// the two never disagree. (The public /models page reuses the landing catalog.)
import { getCombos, getComboPricing, getPricingForModel } from "@/lib/db/index.js";
import { getActiveDiscountsForModels } from "@/lib/db/repos/modelDiscountsRepo.js";
import { applyBpToPricing } from "@/lib/billing/discounts.js";

/**
 * Price of one combo: the admin's combo-level price when set, otherwise the first
 * member model with a resolvable price (pool/default/pattern pricing).
 */
async function comboPrice(combo, comboPricing) {
  const own = comboPricing?.[combo.name];
  if (own) return own;
  for (const m of Array.isArray(combo.models) ? combo.models : []) {
    const slash = m.indexOf("/");
    const provider = slash >= 0 ? m.slice(0, slash) : null;
    const model = slash >= 0 ? m.slice(slash + 1) : m;
    const resolved = await getPricingForModel(provider, model);
    if (resolved) return resolved;
  }
  return null;
}

/**
 * @param {object} opts
 * @param {string[]|null} [opts.allowedModels] combo names a group allows; null/[] = every combo
 * @param {object[]} [opts.combos] combos already loaded (else read)
 * @param {object} [opts.comboPricing] combo prices already loaded (else read)
 * @param {{ userId?: string|null, groupId?: string|null, planId?: string|null }} [opts.discountContext]
 * @returns {Promise<object[]>} `{ name, kind, modelsCount, input, output, cached, reasoning, cacheCreation, discount?, discounted? }`
 */
export async function buildModelPriceList({ allowedModels = null, combos = null, comboPricing = null, discountContext = {} } = {}) {
  const [allCombos, pricing] = await Promise.all([
    combos ? Promise.resolve(combos) : getCombos(),
    comboPricing ? Promise.resolve(comboPricing) : getComboPricing(),
  ]);
  const allow = Array.isArray(allowedModels) && allowedModels.length > 0 ? new Set(allowedModels) : null;
  const visible = (allCombos || []).filter((c) => c?.name && (!allow || allow.has(c.name)));

  let discounts = new Map();
  try {
    discounts = await getActiveDiscountsForModels(visible.map((c) => c.name), discountContext);
  } catch {
    discounts = new Map();
  }

  const out = [];
  for (const c of visible) {
    const p = (await comboPrice(c, pricing)) || {};
    const entry = {
      name: c.name,
      kind: c.kind || "llm",
      modelsCount: Array.isArray(c.models) ? c.models.length : 0,
      input: p.input ?? 0,
      output: p.output ?? 0,
      cached: p.cached ?? 0,
      reasoning: p.reasoning ?? 0,
      cacheCreation: p.cache_creation ?? 0,
    };
    const found = discounts.get(c.name);
    if (found) {
      const low = applyBpToPricing(p, found.totalBp);
      entry.discount = { percentBp: found.totalBp, capped: found.capped, endsAt: found.endsAt, reasons: found.reasons ?? [] };
      entry.discounted = {
        input: low.input ?? 0,
        output: low.output ?? 0,
        cached: low.cached ?? 0,
        reasoning: low.reasoning ?? 0,
        cacheCreation: low.cache_creation ?? 0,
      };
    }
    out.push(entry);
  }
  return out;
}
