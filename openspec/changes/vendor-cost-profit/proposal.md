## Why

The admin currently only sees what customers are charged (the already-shipped sell price, combo or upstream). There is no record of what the upstream vendor actually cost, so the admin cannot tell whether a given request, model, user, or provider connection was profitable. Admins need a per-request profit/loss view, without touching how customers are charged.

## What Changes

- Add a new, admin-only "vendor cost" price per (provider, model), set from the Providers page when adding or editing a custom model. A vendor cost entry may optionally define on-peak and off-peak rates with a daily off-peak time window (Asia/Ho_Chi_Minh); when peak pricing is off, one flat vendor cost applies.
- At the moment a request is logged (same point `costNanoUsd`/`chargedNanoUsd` are computed today), also resolve and snapshot `vendorCostNanoUsd` using the request's own timestamp to pick on-peak vs off-peak. This is a point-in-time snapshot, never recomputed later.
- **BREAKING (additive only, no data loss)**: `usageHistory` and `requestDetails` gain a nullable `vendorCostNanoUsd` column (`SCHEMA_VERSION` 52 → 53). Rows recorded before this change keep `vendorCostNanoUsd = NULL` forever — no backfill, no coercion to 0.
- Usage → Overview gains a profit/loss summary (total revenue, total vendor cost, net profit) and a profit column on relevant tables, NULL-aware.
- Usage → Details gains an "Account" column (which provider connection served the request) and a per-row profit figure.
- Usage → Users gains a "Đã dùng thực (giá vốn)" column — the sum of `vendorCostNanoUsd` for that user's requests in range.
- Usage → Providers gains a cache-hit-ratio column (reusing already-tracked `cacheRead`/`cacheCreation` rollup figures) and an expandable per-connection/account breakdown (today it only aggregates by provider name).
- Customer billing (`pricingRepo.resolvePrice`, discounts, `chargedNanoUsd`) is untouched by all of the above.

## Capabilities

### New Capabilities
- `vendor-cost-pricing`: admin-configured, admin-only vendor (upstream) cost price per provider+model, with an optional on-peak/off-peak schedule, resolved and snapshotted per request at log time; entirely separate from and invisible to customer billing.

### Modified Capabilities
- `admin-usage-views`: Overview gains a profit/loss summary and column; Details gains an account/connection column; Users gains a vendor-cost-used column; Providers gains a cache-hit-ratio column and a per-connection breakdown. None of this changes what any table bills or charges — it only adds derived, NULL-aware reporting columns sourced from the new `vendorCostNanoUsd` snapshot.

## Impact

- Schema: `src/lib/db/schema.js` (`usageHistory`, `requestDetails` TABLES, `SCHEMA_VERSION` 52→53).
- New vendor-cost storage + resolution: new repo module alongside `src/lib/db/repos/pricingRepo.js` (e.g. `vendorCostRepo.js`), using the existing `kv` scope pattern (no new SQL table needed — mirrors how sell-price overrides are stored today).
- Request-time snapshot: `src/lib/db/repos/usageRepo.js` (wherever `costNanoUsd`/`chargedNanoUsd` are computed and inserted into `usageHistory`) and `src/lib/db/repos/requestDetailsRepo.js` (insert path).
- Providers UI: `src/app/(dashboard)/dashboard/providers/[id]/AddCustomModelModal.js` and the existing per-model row edit UI (`ModelRow.js` or equivalent) gain vendor-cost input fields.
- Usage UI/API: `src/shared/components/UsageStats.js`, `UsageTable.js`, `src/app/(dashboard)/dashboard/usage/components/RequestDetailsTab.js`, `UserUsageTable.js`, `ProviderUsageTable.js`, and their backing routes `/api/usage/request-details`, `/api/usage/user-summary`, `/api/usage/provider-summary`, plus `src/lib/db/repos/usageRepo.js` aggregation helpers (sliced reads only, per `usage-dashboard-perf` convention).
- Tests: `test/` additions for vendor-cost resolution (peak precedence, NULL-when-unset) and for NULL-safe profit aggregation.
