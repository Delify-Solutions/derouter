## Why

Every tab of the admin usage page (`/dashboard/usage`) loaded very slowly on production, and the whole admin app (and proxy) felt frozen while it did. Cause, found by reading the code and measuring on a seeded database:

1. `GET /api/usage/stream` re-ran the full `getUsageStats("all")` on every `update` event (one per completed request, throttled to 150 ms) for every open tab. The page discards everything from that stream except four in-memory fields. On a busy installation this is a full scan of `usageHistory` several times a second.
2. Every summary read the whole range into JS and looped over it, parsing JSON per row. better-sqlite3 is synchronous, so the event loop is held for the entire scan: 12–16 s per call at 1.5 M rows, during which nothing else is served.
3. Nothing was cached: each tab switch, refresh and extra browser tab repeated the scan.

## What Changes

- **Live stream is live only.** The SSE route pushes `getActiveRequests()` (in-flight, recent, last failing provider, `pending`) — all in memory. It never computes aggregates. The page already merged only these fields.
- **Overview stats**: the "lastUsed overlay" and the 24 h / today path aggregate inside SQLite (`GROUP BY` + `json_extract`) instead of materialising every row.
- **Time-sliced scans**: the Users and Providers summaries, the overlay and the 24 h path read the range in 3-hour slices and yield to the event loop between them. The longest stall drops from the whole scan to one slice (≈0.1–0.3 s at 1.5 M rows). Results are identical.
- **Stale-while-revalidate cache with single-flight** (`src/lib/cache/swrCache.js`) in front of `stats`, `chart`, `user-summary` and the scan part of `provider-summary`: ten tabs cost one aggregation; a stale value is served at once while one background refresh runs; a failed refresh keeps the stale value. Live fields of `stats` and the per-minute provider rate are read fresh each call.
- `getUsageByOwner` orders models with equal cost and requests by name (was scan order), so the order is stable between refreshes.

## Non-goals

- A cold load (first visit after the cache aged out) still scans the range: ≈0.7 s at 300 k rows, ≈5–7 s at 1.5 M, linear in rows. Making it independent of volume needs pre-aggregated rollup tables (per-minute and per-owner), a schema change with a backfill; deliberately not part of this change.
- `getKeyUsageSummary` (customer `/usage` page) has the same row loop and is not changed here.

## Capabilities

### New Capabilities
- `usage-dashboard-performance`

## Impact

- No schema change. New: `src/lib/cache/swrCache.js`. Changed: `usageRepo.js` (`getUsageStats`, `getUsageByOwner`, `getProviderUsageSummary`, `getActiveRequests` also returns `pending`, slice helper), the four `/api/usage/*` routes, the SSE route.
- Tests: `test/swr-cache.test.js`, `test/usage-aggregation.test.js`. Verified against the previous implementation on randomised data (60 k rows incl. malformed JSON, keyless, deleted keys, legacy float costs): identical output for every period and range, except the two cosmetic ties noted in design.
