// Per-request access enforcement for an LLM call (design D12).
//
// Called by the SSE handlers after the key itself was found to exist. Two very
// different keys reach this function and the difference drives everything:
//
//   CUSTOMER KEY (userId set)
//     Limits belong to the ACCOUNT. The order of checks is deliberate: every
//     access question (is the account allowed to call at all? is the model in
//     their plan-of-record?) is answered before the quota question, because
//     "you are suspended" and "buy a plan" call for different actions from the
//     customer. RPM/TPM are counted across all of the customer's keys, so minting
//     a second key never widens the allowance, and they come from the plan that is
//     paying (not from the group, which only decides the models).
//
//   ADMIN KEY / no key
//     Unchanged: per-key counters, per-key budget window, no admission check
//     (there is no wallet to admit against).
//
// Every denial is a plain object —
//   { ok:false, status, code, message, retryAfterSec?, resetAt? }
// and the caller renders it through platformErrorResponse (D11). This module never
// builds a Response itself so the same verdict is reusable from a test.
//
// Relative imports only (D8/design Context): tests import this file directly under
// plain `node --test`, where the `@/` alias does not resolve.
import { getAdapter } from "../db/driver.js";
import { getApiKeyForAuth, resetKeyWindow } from "../db/repos/apiKeysRepo.js";
import {
  getKeyRateUsage,
  getKeyOldestTokenAt,
  getKeyCostSinceNano,
  getUserRateUsage,
  getUserOldestTokenAt,
} from "../db/repos/usageRepo.js";
import { admitSync } from "../billing/planQueue.js";
import { usdToNano } from "../../shared/utils/money.js";
import { matchesAllowed } from "./modelMatching.js";
import { PLATFORM_MESSAGES, modelNotAllowedMessage, planLimitMessage } from "./platformError.js";

// Max time (ms) to hold a request waiting for TPM room before returning 429.
// Default 30s — balances giving the 60s rolling window time to drain vs not
// holding a client connection open so long it times out. Env-configurable, and an
// explicit 0 means "never wait" (used by tests and by operators who prefer an
// immediate 429), so 0 must NOT fall through to the default.
const TPM_MAX_WAIT_MS = (() => {
  const raw = process.env?.TPM_MAX_WAIT_MS;
  if (raw == null || String(raw).trim() === "") return 30_000;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30_000;
})();

const RATE_WINDOW_MS = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Per-identity serialization queue for the TPM check. Concurrent requests for the
// same identity chain through this promise so they don't all re-check and retry at
// once (which would re-overshoot TPM immediately). Request A holds the lock, sees
// room (or waits for it), then releases; request B acquires, re-checks (A's tokens
// now counted) and waits only if still over. Entries self-clean after the chain
// settles to avoid unbounded Map growth.
//
// The identity is `user:<userId>` for customer keys and `key:<keyId>` for admin
// keys — the same scope the counters use, or two keys of one customer would each
// wait independently and jointly overshoot.
const tpmQueues = new Map(); // lockKey -> Promise
function withTpmLock(lockKey, fn) {
  const prev = tpmQueues.get(lockKey) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run fn after prev settles, success or fail
  tpmQueues.set(lockKey, next);
  next.finally(() => { if (tpmQueues.get(lockKey) === next) tpmQueues.delete(lockKey); });
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

function deny(status, code, message, extra = {}) {
  return { ok: false, status, code, message, ...extra };
}

/** 403 for an owner whose status forbids API use, or null when it is `active`. */
function statusDenial(owner) {
  if (!owner || owner.status === "active") return null;
  if (owner.status === "suspended") {
    return deny(403, "account_suspended", PLATFORM_MESSAGES.account_suspended);
  }
  if (owner.status === "unverified") {
    return deny(403, "account_unverified", PLATFORM_MESSAGES.account_unverified);
  }
  // Any other non-active status (deleted owner, unknown value) is equally a "may
  // not call" answer; naming it suspended would be a lie, so use the group message
  // only for a missing group and this generic one otherwise.
  return deny(403, "account_unverified", PLATFORM_MESSAGES.account_unverified);
}

/** RPM/TPM of the plan a purchase (`userPlans.id`) was bought from; nulls when none is set. */
function planRates(db, userPlanId) {
  const row = db.get(
    `SELECT p.rpm AS rpm, p.tpm AS tpm FROM userPlans up JOIN plans p ON p.id = up.planId WHERE up.id = ?`,
    [userPlanId]
  );
  return { rpm: row?.rpm ?? null, tpm: row?.tpm ?? null };
}

/**
 * RPM/TPM for a customer, counted per user.
 *
 * @param {{ kind:"user", userId:string }|{ kind:"key", apiKey:string, keyId:string }} scope
 */
async function enforceRate(scope, resolved) {
  const read = scope.kind === "user"
    ? () => getUserRateUsage(scope.userId, RATE_WINDOW_MS)
    : () => getKeyRateUsage(scope.apiKey, RATE_WINDOW_MS);
  const readOldest = scope.kind === "user"
    ? () => getUserOldestTokenAt(scope.userId, RATE_WINDOW_MS)
    : () => getKeyOldestTokenAt(scope.apiKey, RATE_WINDOW_MS);

  if (resolved.rpm != null) {
    const { requests } = await read();
    if (requests >= resolved.rpm) {
      return deny(429, "rate_limit", PLATFORM_MESSAGES.rate_limit_rpm, { retryAfterSec: 60 });
    }
  }

  // TPM waits for room instead of failing immediately, so a customer hitting the
  // token ceiling isn't interrupted mid-work. Serialized per identity; capped at
  // TPM_MAX_WAIT_MS, then a hard 429.
  if (resolved.tpm != null) {
    const lockKey = scope.kind === "user" ? `user:${scope.userId}` : `key:${scope.keyId}`;
    const tpmDenial = deny(429, "rate_limit", PLATFORM_MESSAGES.rate_limit_tpm, { retryAfterSec: 60 });
    const tpmCheck = async () => {
      if (TPM_MAX_WAIT_MS <= 0) {
        // Wait disabled — behave like the old hard-429 path.
        const { tokens } = await read();
        return tokens >= resolved.tpm ? tpmDenial : { ok: true };
      }
      const deadline = Date.now() + TPM_MAX_WAIT_MS;
      while (Date.now() < deadline) {
        const { tokens } = await read();
        if (tokens < resolved.tpm) return { ok: true };
        // Sleep until the oldest token in the window should fall out (frees
        // room), capped to a 5s poll interval and the remaining wait budget.
        const oldestIso = await readOldest();
        let waitMs = 2000; // fallback poll when no oldest timestamp available
        if (oldestIso) {
          const oldestAgeMs = Date.now() - new Date(oldestIso).getTime();
          waitMs = Math.max(0, RATE_WINDOW_MS - oldestAgeMs) + 50; // +50ms slack
        }
        waitMs = Math.min(waitMs, deadline - Date.now(), 5000);
        if (waitMs <= 0) break;
        await sleep(waitMs);
      }
      // Still over TPM after the max-wait budget — give up with a 429.
      return tpmDenial;
    };
    return withTpmLock(lockKey, tpmCheck);
  }

  return { ok: true };
}

/**
 * Enforce every limit for an incoming LLM request.
 *
 * @param {string} apiKey - the raw API key
 * @param {string} [model] - the requested model id (combo name or pool model)
 * @returns {Promise<
 *   { ok: true, auth: object|null } |
 *   { ok: false, status: number, code: string, message: string, retryAfterSec?: number, resetAt?: string }
 * >}
 */
export async function enforceKeyLimits(apiKey, model) {
  if (!apiKey) return { ok: true, auth: null }; // no key (requireApiKey false) → no limits

  const auth = await getApiKeyForAuth(apiKey);
  if (!auth) return { ok: true, auth: null }; // unknown key slipped past isValidApiKey guard → let handler's own check reject

  const { key, resolved, owner } = auth;
  const now = Date.now();

  // ── Customer key ────────────────────────────────────────────────────────────
  if (key.userId) {
    // 1. Account status: read per request, so a suspension applies immediately.
    const denial = statusDenial(owner);
    if (denial) return denial;

    // 2. Group present. A group with no allow-list is legitimate ("all models"),
    //    so presence — not emptiness — is the test; isModelAllowed would treat an
    //    empty list as "allow everything" and hide a genuinely ungrouped account.
    if (!auth.group) {
      return deny(403, "model_not_allowed", PLATFORM_MESSAGES.group_missing);
    }

    // 3. Key expiry (per key).
    if (resolved.expiresAt) {
      const exp = new Date(resolved.expiresAt).getTime();
      if (Number.isFinite(exp) && now > exp) {
        return deny(403, "key_expired", PLATFORM_MESSAGES.key_expired);
      }
    }

    // 4-5. RPM then TPM, per user, at the rates of the plan paying right now
    //    (the head of the queue). With no plan able to pay there is no rate to
    //    apply; the admission step below then explains why with 402/429.
    const db = await getAdapter();
    const paying = admitSync(db, key.userId);
    const rate = await enforceRate({ kind: "user", userId: key.userId }, paying.ok ? planRates(db, paying.planId) : {});
    if (!rate.ok) return rate;

    // 6. Model allow-list from the owner's group. Skipped when no model was given
    //    (a non-chat endpoint); an empty allow-list means unrestricted.
    if (model) {
      const allowed = resolved.allowedModels;
      if (Array.isArray(allowed) && allowed.length > 0 && !matchesAllowed(model, allowed)) {
        return deny(403, "model_not_allowed", modelNotAllowedMessage(model));
      }
    }

    // 7. Admission from the plan queue (spec plan-queue-billing "Admission").
    //    Runs LAST so a request refused for an access reason reports that reason,
    //    not quota. A 429 names the instant the first plan reopens; a 402 means no
    //    queued plan has credit left.
    //    Re-read after the rate step: a TPM wait can last seconds, and the queue may
    //    have moved on in that time.
    const admitted = admitSync(db, key.userId);
    if (!admitted.ok) {
      if (admitted.status === 429) {
        return deny(429, "plan_limit", planLimitMessage(admitted.resetAt), {
          retryAfterSec: admitted.retryAfterSec,
          resetAt: admitted.resetAt,
        });
      }
      return deny(402, "insufficient_quota", PLATFORM_MESSAGES.insufficient_quota);
    }

    return { ok: true, auth };
  }

  // ── Admin key ───────────────────────────────────────────────────────────────

  // 1. Expiry (per key)
  if (resolved.expiresAt) {
    const exp = new Date(resolved.expiresAt).getTime();
    if (Number.isFinite(exp) && now > exp) {
      return deny(403, "key_expired", PLATFORM_MESSAGES.key_expired);
    }
  }

  // 2-3. RPM/TPM per key
  const rate = await enforceRate({ kind: "key", apiKey, keyId: key.id }, resolved);
  if (!rate.ok) return rate;

  // 4. Budget ($ cost) with optional reset window. Admin keys keep this: unlike a
  //    customer, an admin key has no plan queue behind it.
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
    } else if (!key.windowStartedAt) {
      // No reset window (e.g. "unlimited" resetWindow but budget set): the budget
      // is lifetime; pin the start at first use.
      windowStart = now;
      await resetKeyWindow(key.id);
    }

    // Integer nanoUSD on both sides — float sums of many small requests drift,
    // and a drifting total either blocks a key early or lets it overspend.
    const costNano = (await getKeyCostSinceNano(apiKey, new Date(windowStart).toISOString())) || 0;
    if (costNano >= usdToNano(resolved.budgetUsd)) {
      return deny(402, "budget_exhausted", PLATFORM_MESSAGES.budget_exhausted, { resetAt });
    }
  }

  // 5. Model allow-list (key narrowed by its own group for admin keys).
  if (model) {
    const allowed = resolved.allowedModels;
    if (Array.isArray(allowed) && allowed.length > 0 && !matchesAllowed(model, allowed)) {
      return deny(403, "model_not_allowed", modelNotAllowedMessage(model));
    }
  }

  return { ok: true, auth };
}

/**
 * Check whether a requested model is permitted for a key (after enforceKeyLimits).
 *
 * Retained for callers that only hold `auth`; the enforcement path above now
 * performs this check itself so the order in D12 holds in one function.
 */
export function isModelAllowed(auth, requestedModel) {
  if (!auth || !auth.resolved?.allowedModels) return true; // null = all models allowed
  const allowed = auth.resolved.allowedModels;
  if (!Array.isArray(allowed) || allowed.length === 0) return true;
  // Tolerant match: provider alias / bare id / dated id / partial date-stripped all collapse.
  return matchesAllowed(requestedModel, allowed);
}

export { PLATFORM_MESSAGES, planLimitMessage };
