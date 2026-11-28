// Cache-miss detection (change cache-miss-auto-refund, capability cache-miss-refund).
//
// Reuses ../../../open-sse/utils/cacheEstimator.js's prefix-matching machinery — the
// same byte-level common-prefix compare and bounded per-scope remembered-text store
// the router already uses to ESTIMATE cache for upstreams that report no usage — for
// a different purpose: flagging a request whose prompt continues the same key's
// immediately preceding one (>= 90% shared prefix) yet reports a COMPLETE miss (zero
// cache-read tokens). Not a second implementation of the prefix comparison.
//
// A dedicated estimator instance is used (not the module's `defaultEstimator`, which
// backs the separate cache-ESTIMATION feature and is scoped by upstream connection —
// this module must compare ACROSS connections, since connection rotation causing a
// miss is exactly the case to catch, and must never surface that as the reason). Its
// scope key is (apiKeyId, provider, effective requested model) and its TTL is the
// lookback window, both independent of the estimation feature's own 10-minute TTL.
//
// This in-memory store is intentionally not persisted: remembered prompt text is a
// transient aid to find "the immediately preceding request", not a historical record
// (the durable record is the `cacheMissDetections` row a flag produces). It is lost on
// a process restart, which only means a request right after a restart is compared
// against nothing — same outcome as "no preceding request within the lookback window"
// (not flagged), never a false positive.
//
// Relative imports only (consumed by plain `node --test`, no `@/` alias, no bare
// `open-sse/...` specifier — see repo CLAUDE.md).
import { createCacheEstimator } from "../../../open-sse/utils/cacheEstimator.js";
import { resolvePrice } from "../db/repos/pricingRepo.js";
import { NANO } from "../../shared/utils/money.js";

// How far back a "same conversation" comparison looks: long enough for a real pause
// between turns, short enough that an old, unrelated session is never compared.
export const CACHE_MISS_LOOKBACK_MS = 6 * 60 * 60 * 1000; // 6 hours

// A request is flagged only when its prompt shares at least this fraction of its own
// prompt tokens as a common prefix with the preceding one.
export const CACHE_MISS_PREFIX_THRESHOLD = 0.9;

const NANO_PER_RATE_UNIT = NANO / 1_000_000; // USD-per-1M-tokens rate -> nanoUSD per token

// Survives Next.js dev hot-reload the same way the DB driver and the billing janitor
// do: a module re-evaluation must not silently start a second, disconnected store.
const g = (globalThis.__cacheMissEstimator ??= {
  estimator: null,
});

function getEstimator() {
  if (!g.estimator) {
    g.estimator = createCacheEstimator({ ttlMs: CACHE_MISS_LOOKBACK_MS });
  }
  return g.estimator;
}

/** Scope key: same API key, provider and effective requested model — no connectionId. */
export function cacheMissScope(apiKeyId, provider, effectiveModel) {
  return `${apiKeyId || ""}|${provider || ""}|${effectiveModel || "unknown"}`;
}

/** Same rule as usageRollup.js / requestDetailsRepo.js's effective requested model. */
export function effectiveRequestedModel(requestedModel, model) {
  return (requestedModel && requestedModel.trim()) || (model && model.trim()) || "unknown";
}

/**
 * Evaluate one just-processed request as a cache-miss candidate.
 *
 * Always remembers the request's own prompt text in the scope's store (so a LATER
 * request can be compared against this one), whether or not this one is flagged.
 *
 * Returns `null` when the request is not eligible or not flagged; otherwise
 * `{ overlapTokens, refundNanoUsd }` where `refundNanoUsd` is capped at the request's
 * OWN recorded cost (not yet capped at what it was actually CHARGED — the caller, who
 * knows the real charged amount only after running the charge, applies that final cap
 * before persisting a detection row).
 *
 * @param {{
 *   apiKeyId: string, provider: string, model: string, requestedModel?: string|null,
 *   promptText: string, promptTokens: number, cacheReadTokens: number, costNanoUsd: number,
 * }} args
 */
export async function evaluateCacheMissCandidate({
  apiKeyId,
  provider,
  model,
  requestedModel = null,
  promptText,
  promptTokens,
  cacheReadTokens = 0,
  costNanoUsd = 0,
} = {}) {
  if (!apiKeyId || !promptText || !(promptTokens > 0)) return null;

  const effectiveModel = effectiveRequestedModel(requestedModel, model);
  const scope = cacheMissScope(apiKeyId, provider, effectiveModel);
  const estimator = getEstimator();

  // Overlap against whatever is already remembered for this scope — i.e. the
  // preceding request(s) within the lookback window — BEFORE this request's own
  // text is added, so a request never "matches itself".
  const overlapTokens = estimator.estimateCachedTokens(scope, promptText, promptTokens);

  // Remember this request's prompt for the next one's comparison, regardless of the
  // outcome below (an identical retry is a no-op: remember() dedupes an identical
  // text already present in the scope's store).
  estimator.remember(scope, promptText);

  // Not flagged: no preceding request within the lookback window, or the preceding
  // one's prompt does not meet the threshold (a new conversation, or the customer's
  // own edited/branched history) — the only disqualifying case.
  const ratio = overlapTokens / promptTokens;
  if (!(ratio >= CACHE_MISS_PREFIX_THRESHOLD)) return null;

  // Not flagged: partial cache (some cache-read tokens) — only a complete miss is in
  // scope, per the locked requirement.
  if (Number(cacheReadTokens) > 0) return null;

  // Eligibility: only a (provider, model) pair whose pricing has a non-zero
  // cached-input rate is considered — re-resolved with the request's OWN recorded
  // fields (never today's price), same pricing precedence every money path uses.
  const { pricing } = await resolvePrice({ provider, model, requestedModel });
  const inputRate = Number(pricing?.input) || 0;
  const cachedRate = Number(pricing?.cached) || 0;
  if (!(cachedRate > 0) || cachedRate >= inputRate) return null;

  const rawRefundNanoUsd = Math.round((inputRate - cachedRate) * NANO_PER_RATE_UNIT * overlapTokens);
  const refundNanoUsd = Math.max(0, Math.min(rawRefundNanoUsd, Math.max(0, Math.round(Number(costNanoUsd) || 0))));
  if (refundNanoUsd <= 0) return null;

  return { overlapTokens, refundNanoUsd };
}
