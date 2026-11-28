## Context

Customer billing already flows through one place, `pricingRepo.resolvePrice` (`src/lib/db/repos/pricingRepo.js:73-128`), storing admin-configured sell-price records in the `kv` table (scope `pricing`) and snapshotting the result per request as `usageHistory.costNanoUsd` / `chargedNanoUsd` (`usageRepo.js:463-690`). This change adds a second, parallel admin-configured price — "vendor cost" (what the admin estimates the upstream actually costs) — resolved and snapshotted the same way, but never read by `resolvePrice` or anything billing-related.

Usage reporting already has two independent aggregation layers that this change must extend in step with each other:
- **Day blobs** (`usageRepo.js` day-blob updater, ~lines 185-225) back Usage → Overview's Model/Account/Key/Endpoint tables for 7d/30d/60d, keyed by upstream model, with an existing precedent for adding a new keyed-by-`requestedModel` dimension via a background, sliced, idempotent rebuild bounded by `LOG_RETENTION_DAYS` (see the shipped `admin-usage-views` capability, "Requested-model history and its limit").
- **Hourly SQL rollups** (`usageRollup.js`) back Usage → Providers (`usageRollupProvider`, keyed `(hour, provider)`, no cache or connection columns today) and Usage → Users (`usageRollupKey`, keyed `(hour, apiKeyId, rawHash, model)`, already carries `cacheRead`/`cacheCreation`). `usageRollup.js:124` already resolves the effective requested model with `COALESCE(NULLIF(requestedModel,''), NULLIF(model,''), 'unknown')` when building `usageRollupKey`. `usageRollup.js:377-417` (`backfillProviderLastTsStepSync`) is the existing precedent for adding a column to already-rolled hours in the background.

`requestDetails` already stores `connectionId` per row (`schema.js:223`) but the Details UI never surfaces it (`RequestDetailsTab.js`).

## Goals / Non-Goals

**Goals:**
- One authoritative vendor-cost resolution and snapshot path, mirroring the existing sell-price path exactly, so the two can never be confused.
- Every aggregate that sums vendor cost can also tell "no data" apart from "zero profit" at any level (one request, one row, one page).
- Reuse the two existing aggregation layers (day blobs, hourly rollups) rather than inventing a third.

**Non-Goals:**
- No change to `pricingRepo.resolvePrice`, combo pricing, discounts, or `chargedNanoUsd`.
- No retroactive estimate of vendor cost for requests recorded before this ships.
- No vendor cost for combos as their own entity — only for the upstream (provider, model) pair that actually answered.

## Decisions

### 1. Vendor cost storage mirrors `pricingRepo`, in a new `vendorCostRepo.js`
Stored in the `kv` table under a new scope (`vendorCost`), same `makeKv`/merge pattern as `pricingRepo.js:6,19-50,131-149`. A record per (provider, model):
```js
{
  rate: { input, output, cached, reasoning, cache_creation },      // on-peak rate, or the only rate if flat
  offPeak: {                                                        // present only when peak-aware
    rate: { input, output, cached, reasoning, cache_creation },
    start: "HH:MM", end: "HH:MM"                                    // Asia/Ho_Chi_Minh, wraps midnight if start > end
  } | undefined
}
```
No record for a (provider, model) pair ⇒ no vendor cost, represented as `null`, never `{}`.
Alternative considered: a dedicated SQL table. Rejected — vendor cost has the exact same cardinality and lifecycle as sell-price overrides (admin-edited, rarely read directly, read once per request at log time), so a second `kv` scope keeps the two symmetric and avoids a schema addition that would need its own CRUD/indexes for no real benefit.

### 2. `resolveVendorCost({ provider, model, atMs })` — exact-match only, date-suffix tolerant
Looks up `vendorCost[provider][model]` (trying the id then its date-stripped form, exactly like `resolvePrice`'s step 2, `pricingRepo.js:90-100`). No combo, no `MODEL_PRICING`, no glob fallback — confirmed by investigation that no "real" upstream cost exists anywhere in the codebase to fall back to; an unset pair must read as genuinely unknown, not inherit a guess. If the record has no `offPeak`, its `rate` applies always. Otherwise, convert `atMs` to Asia/Ho_Chi_Minh local `HH:MM` and compare against `[start, end)`, wrapping past midnight when `start > end` (`22:00`–`06:00` ⇒ off-peak is `[22:00,24:00) ∪ [00:00,06:00)`). Reuses the existing `costFromTokensNano`/`costFromImagesNano` pure functions (`usageRepo.js`, same ones `calculateCostNano` uses) against whichever rate object resolution picks — same token/pricing shape, no duplicate math.

### 3. Snapshot point: beside `calculateCostNano`, same transaction
A new `calculateVendorCostNano(provider, model, tokens, imageCount, atMs)` is called next to `calculateCostNano` (`usageRepo.js:472`) and its result stored in `entry.vendorCostNanoUsd` (nullable — `null` when `resolveVendorCost` found nothing), inserted into both `usageHistory` (`usageRepo.js:604-611`) and `requestDetails` (`requestDetailsRepo.js:158-164`). Never recomputed after insert, so a later price edit cannot change a past request's numbers — matches how `costNanoUsd` already behaves.

### 4. The "priced vs not" pair travels with every aggregate
Every place that sums `vendorCostNanoUsd` also carries a `pricedRequests` count (how many of the summed requests had a non-null vendor cost) alongside the existing `requests` count. `pricedRequests === 0` ⇒ show "no vendor cost data"; `0 < pricedRequests < requests` ⇒ show the figure plus the partial-data note; `pricedRequests === requests` ⇒ plain figure. This one rule implements every NULL-handling scenario in the `admin-usage-views` delta spec, from a single request up to a whole-period Overview summary.

### 5. Day blobs gain `vendorCostNanoUsd` + `pricedRequests` per bucket, same rebuild shape as `requestedModel`
The day-blob updater (`usageRepo.js` ~185-225) adds these two fields to every existing bucket (byModel/byAccount/byApiKey/byEndpoint) going forward. Historical days within `LOG_RETENTION_DAYS` get a background, sliced, idempotent rebuild from raw `usageHistory` — the same mechanism already shipped for `requestedModel` (see `admin-usage-views`'s "Requested-model history and its limit"); the implementation should reuse that rebuild's scheduling/idempotency machinery rather than writing a second one. Days outside retention keep `pricedRequests = 0` forever (consistent with decision #4: reads as "no data", which is correct — those requests cannot be priced retroactively).

### 6. `usageRollupProvider` is widened to `(hour, provider, connectionId)` + cache + vendor columns
Add `cacheRead`, `cacheCreation`, `vendorCostNano`, `pricedRequests` columns and widen the primary key to include `connectionId` (`'' ` for pre-existing rolled hours that cannot be split after the fact — see migration below). This single table then answers both the Providers-tab cache-hit ratio and the per-connection breakdown, and keeps using the project's sliced-rollup-read convention (`forEachRollupSlice`, `usageRepo.js:2108-2160`) instead of a raw scan.
Alternative considered: compute the per-connection breakdown on-demand from raw `usageHistory` only when a row is expanded (cheaper to build, no migration). Rejected as the long-term answer because the cache-hit-ratio column must show on every provider row by default, which needs the aggregate to already exist — doing that lazily would mean two different code paths computing the same number two different ways. Documented as the fallback if the rollup widening proves too large for this change's budget (see Risks).

### 7. `usageRollupKey` gains `vendorCostNano` + `pricedRequests` (no grain change)
It already carries `cacheRead`/`cacheCreation` and is keyed by `(hour, apiKeyId, rawHash, model)`, which already aggregates per user. Adding the two new columns is a plain additive change (`syncSchemaFromTables` handles new nullable/defaulted columns without a versioned migration), backfilled going forward only, exactly like the `usageRollupProvider` widening but without needing a primary-key change.

### 8. Schema migration
`SCHEMA_VERSION` 52 → 53 (one bump covers the whole change, triggering the usual pre-migration backup). New nullable columns on `usageHistory`, `requestDetails`, and the two new columns on `usageRollupKey` are additive — no versioned migration needed, `syncSchemaFromTables` adds them in place. Widening `usageRollupProvider`'s primary key is destructive to that table's existing rows (they cannot be split into per-connection rows after the fact) and needs a versioned migration (`src/lib/db/migrations/009-widen-provider-rollup.js`, mirroring `006-drop-plan-model-limits.js`'s pattern): `DROP TABLE usageRollupProvider`, then let the post-migration additive sync recreate it from the new `schema.js` definition, and reset whatever rollup watermark (`usageRollupMeta`'s `rolledThrough`, `usageRollup.js:29`) governs how far back the hourly builder considers already-rolled, bounded to `LOG_RETENTION_DAYS`, so the normal background rollup repopulates it — no bespoke one-off backfill script needed beyond what already drives the hourly rollup.

### 9. Providers UI
`AddCustomModelModal.js` gains vendor-cost rate fields (same input/output/cached/reasoning/cache_creation shape as the existing sell-price form on `/dashboard/pricing`) plus a "Có giá theo khung giờ" toggle that reveals the off-peak rate fields and the Asia/Ho_Chi_Minh start/end time inputs. The existing per-model row (`ModelRow.js` or equivalent) gets the same fields as an edit affordance. Both call a new `vendorCostRepo.updateVendorCost`/`resetVendorCost` pair, mirroring `pricingRepo.updatePricing`/`resetPricing` exactly.

## Risks / Trade-offs

- **[Risk]** Widening `usageRollupProvider`'s grain is the single largest piece of this change and the one most likely to slip. → **Mitigation**: if it does not fit the change's budget, fall back to decision #6's rejected alternative (on-demand per-connection read on expand, and a simpler cache-ratio figure computed from `usageRollupKey` summed across a provider's models instead of a true per-connection rollup) and record that explicitly as a follow-up — never silently ship the on-demand version while the spec still implies a steady rollup-backed figure.
- **[Risk]** An admin can set a vendor cost rate that makes `vendorCostNanoUsd` exceed `chargedNanoUsd` (a loss). → **Mitigation**: this is a real, intended outcome to report, not a bug — profit figures and UI must render negative profit plainly, never clamp it to zero.
- **[Risk]** Peak-window math done naively in UTC would shift the off-peak boundary with the server's local time. → **Mitigation**: `resolveVendorCost` converts the request timestamp to Asia/Ho_Chi_Minh explicitly (e.g. via `Intl.DateTimeFormat` with `timeZone: "Asia/Ho_Chi_Minh"`), never relying on the host's local timezone.
- **[Risk]** Forgetting the `pricedRequests` counter anywhere `vendorCostNanoUsd` is summed silently turns "no data" into "zero profit". → **Mitigation**: tasks.md calls this out at every aggregation site; tests assert the distinction at the request, bucket, and page-summary levels.

## Migration Plan

1. Add `vendorCostNanoUsd` (nullable) to `usageHistory` and `requestDetails`; add `vendorCostNano`/`pricedRequests` to `usageRollupKey`. Bump `SCHEMA_VERSION` to 53 (additive, no migration file).
2. Add migration `009-widen-provider-rollup.js`: drop `usageRollupProvider`, let additive sync recreate it with the new `(hour, provider, connectionId)` grain and cache/vendor columns, reset the relevant rollup watermark so the background rollup repopulates it within `LOG_RETENTION_DAYS`.
3. Ship `vendorCostRepo.js` + `resolveVendorCost` + `calculateVendorCostNano`, wired into the existing request-logging path, before any UI reads vendor cost — so new requests start carrying it immediately.
4. Ship the day-blob bucket extension + its background rebuild, reusing the `requestedModel` rebuild's scheduling.
5. Ship the Providers UI (set vendor cost) and the four Usage-tab UI changes, in any order, since they only read data the prior steps already produce.
Rollback: the pre-migration backup taken on the `SCHEMA_VERSION` bump restores `usageRollupProvider` to its pre-change shape if migration 009 needs to be reverted; the new nullable columns on `usageHistory`/`requestDetails`/`usageRollupKey` can simply be ignored by older code without any data loss.

## Open Questions

None — every ambiguity above was resolved in favor of a concrete decision (see Risks for the one piece, the rollup widening, whose scope may need to be renegotiated during implementation rather than left open now).
