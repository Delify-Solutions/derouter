import { getApiKeyForAuth, resetKeyWindow } from "@/lib/db/repos/apiKeysRepo.js";
import { getKeyRateUsage, getKeyCostSince } from "@/lib/db/repos/usageRepo.js";
import { matchesAllowed } from "./modelMatching.js";

// Reset window duration in ms.
const WINDOW_MS = {
  "5h": 5 * 60 * 60 * 1000,
  "day": 24 * 60 * 60 * 1000,
  "week": 7 * 24 * 60 * 60 * 1000,
};

function windowDurationMs(resetWindow) {
  return WINDOW_MS[resetWindow] || 0; // 0 = no reset (unlimited-window budget until exhausted)
}

/**
 * Enforce API key limits for an incoming LLM request.
 * Called from SSE handlers after isValidApiKey passes.
 *
 * @param {string} apiKey - the raw api key string
 * @returns {Promise<{ok:true, auth:{key,group,resolved}} | {ok:false, status:number, error:string, retryAfter?:number, resetAt?:string}>}
 */
export async function enforceKeyLimits(apiKey) {
  if (!apiKey) return { ok: true, auth: null }; // no key (requireApiKey false) → no limits

  const auth = await getApiKeyForAuth(apiKey);
  if (!auth) return { ok: true, auth: null }; // unknown key slipped past isValidApiKey guard → let handler's own check reject

  const { key, resolved } = auth;
  const now = Date.now();

  // 1. Expiry (per-key)
  if (resolved.expiresAt) {
    try {
      const exp = new Date(resolved.expiresAt).getTime();
      if (now > exp) return { ok: false, status: 403, error: "Key expired", resetAt: null };
    } catch { /* ignore malformed */ }
  }

  // 2. RPM (requests/min)
  if (resolved.rpm != null) {
    const { requests } = await getKeyRateUsage(apiKey, 60000);
    if (requests >= resolved.rpm) {
      return { ok: false, status: 429, error: "RPM limit exceeded", retryAfter: 60 };
    }
  }

  // 3. TPM (tokens/min)
  if (resolved.tpm != null) {
    const { tokens } = await getKeyRateUsage(apiKey, 60000);
    if (tokens >= resolved.tpm) {
      return { ok: false, status: 429, error: "TPM limit exceeded", retryAfter: 60 };
    }
  }

  // 4. Budget ($ cost) with optional reset window
  if (resolved.budgetUsd != null) {
    const dur = windowDurationMs(resolved.resetWindow);
    let windowStart = key.windowStartedAt ? new Date(key.windowStartedAt).getTime() : now;
    let resetAt = null;

    if (dur > 0) {
      // First-ever request for this key (no window started yet), or the window
      // elapsed — in both cases start a fresh window pinned to now so that
      // subsequent requests in the same window accumulate cost against this point.
      if (!key.windowStartedAt || now - windowStart >= dur) {
        windowStart = now;
        await resetKeyWindow(key.id); // persists windowStartedAt=now, windowCostUsd=0
      }
      resetAt = new Date(windowStart + dur).toISOString();
    } else {
      // No reset window (e.g. "unlimited" resetWindow but budget set): budget is lifetime.
      // windowStart is the key's createdAt-equivalent; use first-seen.
      if (!key.windowStartedAt) {
        windowStart = now;
        await resetKeyWindow(key.id);
      }
      resetAt = null; // never resets
    }

    const costSince = (await getKeyCostSince(apiKey, new Date(windowStart).toISOString())) || 0;
    if (costSince >= resolved.budgetUsd) {
      return { ok: false, status: 402, error: "Budget exhausted", resetAt };
    }
  }

  return { ok: true, auth };
}

/**
 * Check whether a requested model is permitted for the key (after enforceKeyLimits ok).
 * @returns {boolean} true if allowed
 */
export function isModelAllowed(auth, requestedModel) {
  if (!auth || !auth.resolved.allowedModels) return true; // null = all models allowed
  const allowed = auth.resolved.allowedModels;
  if (!Array.isArray(allowed) || allowed.length === 0) return true;
  // Tolerant match: provider alias / bare id / dated id / partial date-stripped all collapse.
  return matchesAllowed(requestedModel, allowed);
}
