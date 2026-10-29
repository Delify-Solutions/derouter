// In-memory sliding-window limiter for the public account endpoints (design D16).
//
// Why in memory: these endpoints are cheap, the deployment is a single instance,
// and a restart resetting the counters is an acceptable trade for having no extra
// table, no cleanup job and no per-attempt write. The doc'd consequence is that a
// restart clears the counters — callers must not rely on the limit holding across
// one.
//
// Buckets are named by the caller (`register:ip:<ip>`, `forgot:email:<email>`), so
// one endpoint can hold several independent limits and the same email and IP are
// never conflated.
import { getClientIp } from "./loginLimiter.js";

// Upper bound on distinct buckets. A rotating attacker can otherwise grow this map
// without limit; 10 000 is far above any real traffic pattern and small enough to
// stay a few hundred kilobytes.
const MAX_BUCKETS = 10_000;

// Survives Next.js dev hot-reload; a restart forgets everything (documented).
if (!global._actionLimiter) global._actionLimiter = { buckets: new Map() };
const store = global._actionLimiter;

function pruneExpired(bucket, now, windowMs) {
  // Entries are kept only while they can still count toward a limit. A bucket is
  // dropped entirely once nothing falls inside the window, which is what keeps the
  // map from leaking keys.
  const hits = bucket.filter((at) => now - at < windowMs);
  return hits;
}

function evictOldestIfNeeded() {
  while (store.buckets.size > MAX_BUCKETS) {
    const oldest = store.buckets.keys().next().value;
    if (oldest === undefined) return;
    store.buckets.delete(oldest);
  }
}

/**
 * Count one attempt against `bucket` and report whether it is within `limit`.
 *
 * A denied attempt is NOT recorded: otherwise a client that keeps hammering would
 * push its own window forward forever and never recover, which turns an abuse
 * guard into a permanent ban. The caller decides whether to record a hit on
 * success or on every attempt; both are correct for the endpoints using this.
 *
 * @param {string} bucket unique name, e.g. "register:ip:1.2.3.4"
 * @param {{ limit:number, windowMs:number, now?:number }} options
 * @returns {{ allowed:boolean, retryAfterSec:number, remaining:number }}
 */
export function hitLimit(bucket, { limit, windowMs, now = Date.now() } = {}) {
  const max = Math.max(1, Math.floor(Number(limit) || 1));
  const window = Math.max(1, Math.floor(Number(windowMs) || 3_600_000));

  const existing = store.buckets.get(bucket);
  const hits = existing ? pruneExpired(existing, now, window) : [];

  if (hits.length >= max) {
    // Wait until the OLDEST hit falls out of the window: that is the first moment
    // an attempt would be allowed again.
    const oldest = hits[0];
    const retryAfterSec = Math.max(1, Math.ceil((oldest + window - now) / 1000));
    // Re-insert the pruned list so a bucket with stale entries still shrinks.
    store.buckets.set(bucket, hits);
    return { allowed: false, retryAfterSec, remaining: 0 };
  }

  hits.push(now);
  store.buckets.set(bucket, hits);
  evictOldestIfNeeded();
  return { allowed: true, retryAfterSec: 0, remaining: Math.max(0, max - hits.length) };
}

/** Drop every bucket — tests only; a running server must never call this. */
export function resetAll() {
  store.buckets.clear();
}

/** Current number of tracked buckets (tests and diagnostics). */
export function bucketCount() {
  return store.buckets.size;
}

/**
 * Apply a list of limits, all of which must pass. Returns the first failure, so the
 * caller answers with one 429 rather than counting an attempt twice.
 *
 * @param {Array<{ bucket:string, limit:number, windowMs:number }>} limits
 * @param {number} [now]
 * @returns {{ allowed:boolean, retryAfterSec:number, bucket:string|null }}
 */
export function checkLimits(limits, now = Date.now()) {
  for (const entry of limits) {
    const result = hitLimit(entry.bucket, { limit: entry.limit, windowMs: entry.windowMs, now });
    if (!result.allowed) {
      return { allowed: false, retryAfterSec: result.retryAfterSec, bucket: entry.bucket };
    }
  }
  return { allowed: true, retryAfterSec: 0, bucket: null };
}

export { getClientIp };
