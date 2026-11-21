## Why

Customers buy combos ("glm-5") and the router answers each request with whichever upstream model the combo picked. The admin usage views (Usage → Overview, Usage → Details) group and label everything by that upstream model, so the operator cannot see what customers actually called or how much each sold product earned. The tables also lack a consistent way to search, filter, sort (e.g. "keys used most / least") and cut to a Top N; Users has no sort at all and Details cannot filter by model.

## What Changes

- Usage → Overview and Usage → Details get a "Model: Khách gọi | Gốc" switch, default "Khách gọi" (the model the client asked for), kept in the URL (`modelView=requested|upstream`).
  - "Khách gọi" groups the Model, Account, Key and Endpoint tables by the requested model; "Gốc" is today's upstream view, unchanged.
  - A row with no recorded requested model counts under its upstream model (the rule the hourly rollup already uses).
- Daily usage blobs also record requested-model aggregates from now on. Days still inside the raw-history retention are backfilled in the background, in slices and idempotently. Older days only have upstream data; the Overview names the first day with requested data.
- `requestDetails` gets a `requestedModel` column (schema bump, backfilled from the stored JSON). Details shows the model per the switch, filters by model and sorts by time, tokens or latency.
- One shared toolbar is used by the Users, Overview, Details and Providers tables:
  - free-text search;
  - filters for model, provider and user where the table has that column;
  - "Sắp xếp theo" with direction "Nhiều → ít" / "Ít → nhiều";
  - Top 10 / 20 / 50 / Tất cả.
  - Its state lives in the URL, and column-header sorting stays in sync with it.
- Every table shows explicit loading, error (with "Thử lại") and empty-after-filter ("Không có dữ liệu khớp bộ lọc" + "Xoá bộ lọc") states.
- **Not changed:** billing. A customer is still charged the combo price when one is set, otherwise the upstream model price. Cost columns only re-aggregate the already-recorded `costNanoUsd`.

## Capabilities

### New Capabilities
- `admin-usage-views`: the admin usage tabs' model view switch (requested vs upstream), the requested-model daily aggregates and their backfill, the Details model filter and sort, and the shared search / filter / sort / Top N toolbar.

### Modified Capabilities
- `admin-user-management`: "Usage by customer" no longer has one fixed order (cost, highest first). That stays the default, but the shared toolbar can re-sort and cut the list. "Request details show the key owner" is unchanged.

## Impact

- **Data:**
  - `src/lib/db/repos/usageRepo.js`: the day-blob writer, `getUsageStats(period, { modelView })` and the new backfill.
  - `src/lib/db/repos/requestDetailsRepo.js`.
  - `src/lib/db/schema.js`: the `requestDetails.requestedModel` column and its index; `SCHEMA_VERSION` 43 → 44.
- **API (admin-only, additive params):**
  - `GET /api/usage/stats`: `modelView`; the SWR cache is keyed by period and view.
  - `GET /api/usage/request-details`: `modelView`, `model`, `sort`, `order`.
- **UI:**
  - `src/shared/components/UsageStats.js` and `UsageTable.js`.
  - `src/app/(dashboard)/dashboard/usage/page.js`.
  - `src/app/(dashboard)/dashboard/usage/components/{UserUsageTable,ProviderUsageTable,RequestDetailsTab}.js`.
  - A new shared toolbar component and a pure sort/filter helper.
- **Out of scope:** billing and pricing, `/dashboard/stats` (it already groups by requested or upstream), the customer `/account` area, and the error log.
