// Small in-memory stale-while-revalidate cache with single-flight, for expensive
// read-only admin summaries (the usage dashboard).
//
//   age < ttlMs                fresh      → returned as is
//   ttlMs <= age < staleMs     stale      → returned at once; ONE background refresh starts
//                                           (default staleMs = 4 × ttlMs; a failed refresh is
//                                           not retried for 10 s)
//   otherwise / nothing cached cold       → the caller waits for ONE shared computation
//
// Concurrent callers of the same key never start a second computation, so ten admin tabs
// (or a tab that polls) cost one aggregation, not ten. A failed computation is never
// cached: a stale value stays served, and a cold caller sees the error.
//
// Per-process memory only. The data is admin-only aggregates, never per-customer state,
// and the key must include every input that changes the answer.
//
// No imports: tests load this file under plain `node --test`.

const MAX_ENTRIES = 200;
// After a failed refresh, wait this long before trying again: while the database is
// failing, every stale-window request would otherwise start another full scan.
const FAILURE_BACKOFF_MS = 10_000;

function store() {
  // global so a Next.js dev reload (new module instance) keeps one cache
  if (!globalThis.__swrCache) globalThis.__swrCache = new Map();
  return globalThis.__swrCache;
}

function evictIfFull(map) {
  // Oldest first, but never an entry whose computation is still running: dropping it
  // would let a second caller start a duplicate computation of the same key.
  for (const [key, entry] of map) {
    if (map.size < MAX_ENTRIES) return;
    if (!entry.inflight) map.delete(key);
  }
}

/**
 * @param {string} key
 * @param {{ ttlMs: number, staleMs?: number, now?: () => number }} opts
 * @param {() => Promise<any>|any} compute
 */
export async function swr(key, { ttlMs, staleMs = ttlMs * 4, now = Date.now }, compute) {
  const map = store();
  let entry = map.get(key);
  const at = now();

  const refresh = () => {
    if (entry?.inflight) return entry.inflight;
    const inflight = (async () => compute())()
      .then((value) => {
        map.delete(key); // re-insert so the Map order tracks the newest write
        evictIfFull(map);
        map.set(key, { value, at: now(), inflight: null });
        return value;
      })
      .catch((error) => {
        const current = map.get(key);
        if (current) {
          current.inflight = null;
          current.retryAt = now() + FAILURE_BACKOFF_MS;
        }
        throw error;
      });
    if (entry) entry.inflight = inflight;
    else { entry = { value: undefined, at: 0, inflight, empty: true }; map.set(key, entry); }
    return inflight;
  };

  if (entry && !entry.empty) {
    const age = at - entry.at;
    if (age < ttlMs) return entry.value;
    if (age < staleMs) {
      // Serve the old value now; the refresh runs in the background and must not
      // surface as an unhandled rejection (the old value stays in place on failure).
      if (!(entry.retryAt && at < entry.retryAt)) refresh().catch(() => {});
      return entry.value;
    }
  }
  try {
    return await refresh();
  } finally {
    const current = map.get(key);
    if (current?.empty && !current.inflight) map.delete(key);
  }
}

/** Drop one key, or everything when called without one. */
export function clearSwrCache(key) {
  const map = store();
  if (key === undefined) map.clear();
  else map.delete(key);
}
