import { getApiKeyForAuth, resetKeyWindow } from "@/lib/db/repos/apiKeysRepo.js";
import { getKeyRateUsage, getKeyOldestTokenAt, getKeyCostSince } from "@/lib/db/repos/usageRepo.js";
import { matchesAllowed } from "./modelMatching.js";

// Max time (ms) to hold a request waiting for TPM room before returning 429.
// Default 30s — balances giving the 60s rolling window time to drain vs not
// holding a client connection open so long it times out. Env-configurable.
const TPM_MAX_WAIT_MS = Math.max(0, parseInt(process.env?.TPM_MAX_WAIT_MS ?? "30000", 10) || 30000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Per-key-id serialization queue for the TPM check. Concurrent requests for the
// same key chain through this promise so they don't all re-check and retry at
// once (which would re-overshoot TPM immediately). Request A holds the lock,
// sees room (or waits for it), then releases; request B acquires, re-checks
// (A's tokens now counted) and waits only if still over. Entries self-clean
// after the chain settles to avoid unbounded Map growth.
const tpmQueues = new Map(); // keyId -> Promise
function withTpmLock(keyId, fn) {
  const prev = tpmQueues.get(keyId) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run fn after prev settles, success or fail
  tpmQueues.set(keyId, next);
  next.finally(() => { if (tpmQueues.get(keyId) === next) tpmQueues.delete(keyId); });
  return next;
}

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

  // 3. TPM (tokens/min) — wait for room instead of a hard 429, so a key holder
  // hitting TPM isn't interrupted mid-work. Serialized per key.id so concurrent
  // requests don't all re-check and retry at once (re-overshooting). Cap the
  // total wait at TPM_MAX_WAIT_MS (default 30s); if still over, fall back to 429.
  if (resolved.tpm != null) {
    const tpmCheck = async () => {
      if (TPM_MAX_WAIT_MS <= 0) {
        // Wait disabled — behave like the old hard-429 path.
        const { tokens } = await getKeyRateUsage(apiKey, 60000);
        if (tokens >= resolved.tpm) return { ok: false, status: 429, error: "TPM limit exceeded", retryAfter: 60 };
        return { ok: true };
      }
      const deadline = Date.now() + TPM_MAX_WAIT_MS;
      while (Date.now() < deadline) {
        const { tokens } = await getKeyRateUsage(apiKey, 60000);
        if (tokens < resolved.tpm) return { ok: true };
        // Sleep until the oldest token in the window should fall out (frees
        // room), capped to a 5s poll interval and the remaining wait budget.
        const oldestIso = await getKeyOldestTokenAt(apiKey, 60000);
        let waitMs = 2000; // fallback poll when no oldest timestamp available
        if (oldestIso) {
          const oldestAgeMs = Date.now() - new Date(oldestIso).getTime();
          waitMs = Math.max(0, 60000 - oldestAgeMs) + 50; // +50ms slack
        }
        waitMs = Math.min(waitMs, deadline - Date.now(), 5000);
        if (waitMs <= 0) break;
        await sleep(waitMs);
      }
      // Still over TPM after the max-wait budget — give up with a 429.
      return { ok: false, status: 429, error: "TPM limit exceeded", retryAfter: 60 };
    };
    const result = await withTpmLock(key.id, tpmCheck);
    if (!result.ok) return result;
    // ok: fall through to the budget check below
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
