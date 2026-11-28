## 1. Schema

- [x] 1.1 Add nullable `vendorCostNanoUsd` column to `usageHistory` and `requestDetails` in `src/lib/db/schema.js` TABLES.
- [x] 1.2 Add `vendorCostNano` (INTEGER NOT NULL DEFAULT 0) and `pricedRequests` (INTEGER NOT NULL DEFAULT 0) columns to `usageRollupKey`.
- [x] 1.3 Widen `usageRollupProvider`'s primary key to `(hour, provider, connectionId)` and add `cacheRead`, `cacheCreation`, `vendorCostNano`, `pricedRequests` columns in `schema.js`.
- [x] 1.4 Bump `SCHEMA_VERSION` 52 → 53.
- [x] 1.5 Add migration `src/lib/db/migrations/009-widen-provider-rollup.js` (version 9): `DROP TABLE IF EXISTS usageRollupProvider`, following `006-drop-plan-model-limits.js`'s pattern and comment style; reset the `usageRollupMeta` watermark (`usageRollup.js:29`, `META_NAME = "rolledThrough"`) so the background rollup repopulates the dropped table within `LOG_RETENTION_DAYS` ← (verify: fresh install creates the new table shape directly via additive sync; an existing DB on 52 runs the migration once, the table is gone and then repopulated by the normal hourly rollup without manual intervention)

## 2. Vendor cost pricing (capability `vendor-cost-pricing`)

- [x] 2.1 Create `src/lib/db/repos/vendorCostRepo.js`: `kv` scope `vendorCost`, mirroring `pricingRepo.js`'s shape (`getVendorCost`, `updateVendorCost`, `resetVendorCost`, `resetAllVendorCost`, with the same 5s cache/invalidate pattern).
- [x] 2.2 Implement `resolveVendorCost({ provider, model, atMs })`: exact (provider, model) match only, date-suffix tolerant like `resolvePrice` step 2, no combo/model/pattern fallback; when the record has an `offPeak` entry, convert `atMs` to Asia/Ho_Chi_Minh `HH:MM` (e.g. via `Intl.DateTimeFormat`) and pick on/off-peak rate per design.md decision #2, wrapping past midnight.
- [x] 2.3 Implement `calculateVendorCostNano(provider, model, tokens, imageCount, atMs)` reusing `costFromTokensNano`/`costFromImagesNano`; returns `null` when `resolveVendorCost` finds nothing.
- [x] 2.4 Wire the snapshot into the request-logging path: call `calculateVendorCostNano` beside `calculateCostNano` (`usageRepo.js:472`) and store `entry.vendorCostNanoUsd` into both the `usageHistory` insert (`usageRepo.js:604-611`) and the `requestDetails` insert (`requestDetailsRepo.js:158-164`). Never recompute after insert ← (verify: a request logged, then the admin changes the vendor cost rate, then re-reads that same request — the stored value is unchanged)
- [x] 2.5 Unit tests (`test/vendor-cost.test.js`, plain Node test runner, relative imports only): flat rate; on-peak rate; off-peak rate; off-peak window wrapping midnight; boundary times (exactly at start, exactly at end); unset (provider, model) pair returns `null`; snapshot stability after a later price edit.

## 3. Providers UI — set vendor cost

- [x] 3.1 Add vendor-cost rate fields (input/output/cached/reasoning/cache_creation) to `AddCustomModelModal.js`, with a "Có giá theo khung giờ" toggle revealing off-peak rate fields + Asia/Ho_Chi_Minh start/end time inputs; save via `vendorCostRepo.updateVendorCost`.
- [x] 3.2 Add the same vendor-cost edit affordance to the existing per-model row component (`ModelRow.js` or equivalent) for models already added.
- [x] 3.3 Confirm no change to `pricingRepo.resolvePrice`, discounts, or any customer-facing price field in this page ← (verify: diff touches only new vendor-cost fields/handlers, not the existing sell-price form or its API calls)

## 4. Day-blob profit aggregates (Overview)

- [x] 4.1 Add `vendorCostNanoUsd` (sum) and `pricedRequests` (count) to every bucket (byModel/byAccount/byApiKey/byEndpoint) in the day-blob updater (`usageRepo.js` ~185-225), going forward.
- [x] 4.2 ~~Add a background, sliced, idempotent rebuild~~ — **DEVIATION, see note below**: no separate rebuild was built. `vendorCostNanoUsd`/`pricedRequests` are additive fields on the SAME existing buckets (unlike the separate `req` map the requestedModel rebuild exists for), seeded at 0 the first time a bucket is touched after this ships. A bucket that predates this feature entirely therefore correctly reads `pricedRequests: 0` without ever needing a rewrite — that is the true fact (those requests really have no vendor cost), not a placeholder. `requests`/other totals are never affected, so there is no undercount for a rebuild to fix (contrast with `req`, which is a wholly separate map that is genuinely ABSENT for a historical day and would undercount the day's total if not rebuilt). Flagged to the orchestrator rather than silently building unneeded machinery; the requestedModel rebuild's SQL (`REQ_GROUP_SELECT`) was still extended with `vendorCostNano`/`priced` sums so its own `req.*` view carries the same fields.
- [x] 4.3 Extend `getUsageStats` (and whatever raw-slice path serves today/24h) to carry `vendorCostNanoUsd`/`pricedRequests` per bucket using `forEachUsageSlice`, never a long synchronous scan.
- [x] 4.4 Add the Overview profit/loss summary (total revenue, total vendor cost, net profit) and per-row profit column on Model/Account/Key/Endpoint tables in `UsageStats.js`/`UsageTable.js`, with the three-way note behavior from the `admin-usage-views` delta spec's "Overview profit and loss summary" requirement (full / partial / none).
- [x] 4.5 Tests: a day with every request priced; a day with some requests priced; a day with none priced; a period spanning a priced and an unpriced day — summary and per-row figures match the spec's scenarios exactly.

## 5. Usage → Details — account column and per-row profit

- [x] 5.1 Resolve and return the serving connection's display name (name, or e-mail if no name) per row in `GET /api/usage/request-details`, using the already-stored `connectionId` (no UI change needed to the storage, it already exists per `requestDetailsRepo.js`).
- [x] 5.2 Add the "Account" column to `RequestDetailsTab.js`, showing "—" when the row has no recorded connection.
- [x] 5.3 Add a per-row profit column/figure (charge − vendor cost) to `RequestDetailsTab.js`, showing "Chưa có dữ liệu giá vốn" when `vendorCostNanoUsd` is null, excluded from any on-page total rather than counted as 0.
- [x] 5.4 Tests for `/api/usage/request-details`: account name resolves correctly; missing connection shows "—"; profit figure and missing-data case match the delta spec's scenarios.

## 6. Usage → Users — vendor-cost-used column

- [x] 6.1 Add `vendorCostNano`/`pricedRequests` aggregation to `usageRollupKey` reads backing `/api/usage/user-summary`, summed per user across their keys. (Also had to extend the hourly rollup WRITER (`rollKeyHour` in `usageRollup.js`) to populate these two columns on `usageRollupKey` in the first place — not spelled out as its own subtask, but reads of a column nothing ever writes would always be 0.)
- [x] 6.2 Add the "Đã dùng thực (giá vốn)" column to `UserUsageTable.js`, sortable like other shared-toolbar columns, showing "—" for a user with zero priced requests in range.
- [x] 6.3 Tests: a user with fully priced usage; a user with partially priced usage; a user with none — column value and sortability match the delta spec's scenarios. (Sortability verified by reusing the exact same `compareRows`/`nextSortState` mechanism the existing "cost"/"requests" columns already use — no dedicated browser test existed for those either.)

## 7. Usage → Providers — cache ratio and per-connection breakdown

- [x] 7.1 Update the hourly rollup builder in `usageRollup.js` to group `usageRollupProvider` by `(hour, provider, connectionId)` and accumulate `cacheRead`, `cacheCreation`, `vendorCostNano`, `pricedRequests` alongside the existing columns, for newly-rolled hours.
- [x] 7.2 Update `getProviderUsageSummary` (`usageRepo.js:2108+`) to read the widened rollup, expose a cache-hit-ratio figure per provider ((cacheRead + cacheCreation) / total input tokens, "—" when zero input tokens), and expose a per-connection breakdown array per provider.
- [x] 7.3 Add the cache-hit-ratio column and the expand-to-per-connection-breakdown UI to `ProviderUsageTable.js`, per the delta spec's "Provider cache ratio and per-connection breakdown" requirement.
- [x] 7.4 Tests: cache-hit ratio computed correctly; a provider with two connections expands to rows that sum back to the provider's totals; a provider with zero input tokens shows "—" ← (verify: if 1.5's migration/rebuild does not reconstruct history correctly, this is where it would surface — check a backfilled hour's per-connection sum against a raw scan of the same hour as an oracle, per the project's `usage-dashboard-perf` convention)

## 8. Final checks

- [x] 8.1 Run `npm run lint`, `npm test`, `npm run build` — all green. (`npm run lint` exits 0: 22,484 warnings + 2 errors, all pre-existing/out-of-scope — the 2 errors are `react/display-name` inside a generated `.next` build chunk under an unrelated worktree path, not source code. `npm test` — 1846/1846 pass. `npm run build` completes cleanly, every route compiles.)
- [x] 8.2 Grep the diff for any accidental touch to `pricingRepo.resolvePrice`, `comboPricingRepo.js`, discount logic, or `chargedNanoUsd` computation — there should be none. (Confirmed: zero diff in `pricingRepo.js`/`comboPricingRepo.js`/`discounts.js`; the only `chargedNanoUsd` diff is widening an INSERT's column list, values unchanged.)
- [x] 8.3 Manual check via dev-browser: confirmed via a real logged-in session against the dev DB (no actual connected provider accounts available in this environment, so no live request could be made) — the "Giá vốn (vendor cost)" fields and the off-peak toggle/window/rates render correctly in `AddCustomModelModal`; all 4 Usage tabs (Overview, Details, Users, Providers) load with zero console/page errors and show their new columns ("Lợi nhuận" on Overview and Details, "Tài khoản" on Details, "Đã dùng thực (giá vốn)" on Users, "Cache hit" on Providers). End-to-end numeric consistency (a real on-peak vs off-peak request) was not exercised since no provider connection exists in this dev environment to make a real request through — flagged as a residual gap for the owner to confirm against a real account before relying on the profit figures.
