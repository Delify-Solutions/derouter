// Customer keys pay per token, so a model with no token price must not be served
// to them: the request would be recorded at $0 and cost the customer nothing
// (calculateCostNano returns 0 when no price resolves). Image generation already
// refuses unpriced models the same way (refuseUnpricedImage). Admin and local keys
// have no owner, are never billed, and are never refused.
//
// Relative imports only: tests import this file under plain `node --test`.
import { resolveApiKeyOwner } from "../db/repos/billingRepo.js";

export function unpricedModelMessage(model) {
  return `Model ${model} chưa được đặt giá nên chưa mở cho API key của khách hàng.`;
}

/** Does `pricing` charge anything for tokens? */
export function hasTokenPrice(pricing) {
  if (!pricing || typeof pricing !== "object") return false;
  return ["input", "output", "cached", "reasoning", "cache_creation"].some((field) => {
    const value = Number(pricing[field]);
    return Number.isFinite(value) && value > 0;
  });
}

/**
 * The denial for a customer key asking for a model with no token price, or null
 * when the call may proceed. A failed price lookup refuses too: serving the
 * request would bill it at $0, which is the defect this guards against.
 *
 * @param {object} db adapter
 * @param {{ apiKey?: string|null, provider: string, model: string, requestedModel?: string|null,
 *           resolvePrice: (args: object) => Promise<{ pricing: object|null }> }} args
 * @returns {Promise<{ status:number, code:string, message:string } | null>}
 */
export async function refuseUnpricedModel(db, { apiKey, provider, model, requestedModel = null, resolvePrice }) {
  if (!apiKey) return null;
  if (!resolveApiKeyOwner(db, apiKey)) return null;
  let pricing = null;
  try {
    ({ pricing } = await resolvePrice({ provider, model, requestedModel }));
  } catch (error) {
    console.error("[billing] price lookup failed, refusing customer request:", error?.message || error);
  }
  if (hasTokenPrice(pricing)) return null;
  return { status: 403, code: "model_not_priced", message: unpricedModelMessage(requestedModel || `${provider}/${model}`) };
}
