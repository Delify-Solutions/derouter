## Why

`usage-dashboard-performance` stopped the dashboard from freezing the server, but a cold load of the Users, Providers and Overview tabs still scans the whole range: linear in traffic (≈5–7 s at 1.5 M rows). The owner asked for the dashboard to stay fast as data grows, which needs the answer to be precomputed.

## What Changes

- **Hourly rollups** of `usageHistory`: `usageRollupProvider` (per hour × provider: requests, tokens, cost, per-minute peaks, fastest request), `usageRollupKey` (per hour × key × effective model: tokens, cache reads/creations, cost, last use), `usageRollupOwnerPeak` (per hour × owner: per-minute peaks) and `usageRollupMeta` (the watermark). `SCHEMA_VERSION` 39 → 40.
- **Exact by construction.** A range is split at hour boundaries: whole hours come from the rollup, the (at most two) partial edges and everything newer than the watermark come from the raw rows. The result equals a raw read; a rollup that has not caught up is slower, never wrong. Peaks never straddle an hour, so a peak is the maximum of per-hour peaks.
- **Caught up in the background** (`scheduleRollup`): one hour per turn of the event loop, started by the first read; the first run backfills every retained row (up to `LOG_RETENTION_DAYS`, default 60 days) while reads keep working on raw rows. An hour is rolled once it ended more than 30 minutes ago, so a request recorded after its hour boundary is still counted.
- **Stays consistent with the raw table**: deleting a customer's request log invalidates the rollup from the oldest hour touched; retention pruning drops rolled hours with the raw rows. The key table stores a SHA-256 of a legacy raw API key, never the key.
- **Overview**: the "lastUsed" refinement from a date to a timestamp only scans the last 48 hours (the page shows "12m ago"/"3h ago" under a day and a date beyond it), removing the scan that dominated the 30d/60d/all views.

## Non-goals
- No rollup for `getKeyUsageSummary` (customer `/usage`): it reads one key's rows through `idx_uh_apikey_ts`, bounded by that customer's traffic, not the whole table.
- Per-owner peaks are fixed when an hour is rolled: a key deleted or reassigned afterwards keeps its old owner's peak for that hour (per-key totals follow the live owner).
- Wiping the history of a key used over the whole retention window invalidates the rollup from that key's first hour; reads then fall back to raw rows until the background loop catches up.
- A row recorded more than the lag after its hour ended is not seen until that hour is re-rolled (call `invalidateRollupFromSync`).

## Capabilities
### Modified Capabilities
- `usage-dashboard-performance`

## Impact
- Schema: four new tables, `SCHEMA_VERSION` 40. New `src/lib/db/repos/usageRollup.js`; `usageRepo.js` (`getProviderUsageSummary`, `getUsageByOwner`, `getUsageStats` overlay, `deleteKeyUsageHistory`, retention prune).
- Tests: `test/usage-rollup.test.js`.
