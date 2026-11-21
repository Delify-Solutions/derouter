## 1. Requested aggregates in day blobs

- [x] 1.1 In `src/lib/db/repos/usageRepo.js`, have `aggregateEntryToDay` also maintain `day.req` (`byModel` with a `providers` request tally, `byAccount`, `byApiKey`, `byEndpoint`), keyed by the effective requested model (`requestedModel || model || "unknown"`) with the same counter values as the upstream maps (design D1). A blob created by this write starts with `req.complete = true`. An existing blob without `req.complete` gets only its upstream maps updated (design D2).
- [x] 1.2 Implement the requested-day rebuild (design D3).
  - **Scheduler:** `scheduleRequestedBackfill(db)`, one loop per process, started from a microtask. Exposes progress `{ running, pendingDays }`.
  - **Eligible days:** blob days with `req.complete !== true`, whose local start is ≥ retention cut-off + 1 day. Newest first.
  - **Per day:**
    - snapshot `MAX(id)`;
    - sliced scan via `forEachUsageSlice`, with SQL extraction mirroring `aggregateEntryToDay`;
    - one synchronous commit that re-checks `complete`, adds the `id > maxId` delta, and writes `req` with `complete: true`.
  - **Failure:** logs one line without secrets and leaves the day incomplete.
- [x] 1.3 Add `getUsageStats(period, { modelView })` (design D4).
  - **Requested view:**
    - read from `day.req` for complete days; for other days, fall back to the upstream maps under the upstream model name;
    - return `requestedSince` and `requestedPartial`;
    - Model rows carry `providers` (descending by requests).
  - **Raw path:** the today/24h path and the 48 h `lastUsed` overlay group by the effective requested model in the requested view.
  - **Unchanged in both views:** totals, `byProvider`, `last10Minutes`, `recentRequests` and `pending`.
  - **Rebuild:** trigger `scheduleRequestedBackfill` when the requested view is read.
- [x] 1.4 In `GET /api/usage/stats`, accept `modelView` (default and fallback `requested`) and key the SWR cache by `period:modelView`. Return the rebuild progress for the "Đang tính lại…" note. ← (verify: totals identical in both views for today/24h/7d/30d/60d; requested Model rows sum to the totals; upstream view output byte-identical to before for the same data)

## 2. Request details: requested model column, filter, sort

- [x] 2.1 In `src/lib/db/schema.js`, add `requestDetails.requestedModel TEXT` and the expression index `idx_rd_effmodel` on `COALESCE(NULLIF(requestedModel, ''), model)` (see 6.8), and bump `SCHEMA_VERSION` 43 → 44. Backfill the column once from `json_extract(data,'$.requestedModel')` for rows where it is NULL (design D5). Make the flush in `requestDetailsRepo.js` write the column.
- [x] 2.2 Extend `getRequestDetails` with:
  - `modelView`;
  - `model`, matched per view (requested: `COALESCE(NULLIF(requestedModel,''), model)`);
  - `sort` ∈ {time, tokens, latency} and `order` ∈ {desc, asc}.
  - **Ordering:** nulls last, then `timestamp DESC` as the tiebreak.
  - **Model options:** return the distinct models of the view, at most 500.
- [x] 2.3 In `GET /api/usage/request-details`:
  - parse and validate `modelView`, `model`, `sort` and `order` (HTTP 400 on an invalid `sort` or `order`);
  - pass them through;
  - return the model options and both model names per row. ← (verify: filter by combo returns only its requests across upstreams with correct pagination counts; tokens/latency sort puts null rows last in both directions; pre-existing rows are filterable by requested model)

## 3. Shared toolbar

- [x] 3.1 Add the pure helper `src/shared/utils/tableQuery.js` (relative imports only):
  - `applyTableQuery`: case-insensitive search across given fields, equality filters, sort with ties by name ascending and empty values last in both directions, then Top N;
  - `readTableQuery` / `writeTableQuery`: namespaced URL keys `<ns>.q`, `<ns>.sort`, `<ns>.dir`, `<ns>.top`, `<ns>.f.<name>`.
- [x] 3.2 Add the `src/shared/components/TableToolbar.js` component:
  - **Controls:**
    - "Tìm kiếm" input;
    - optional "Model" / "Provider" / "Người dùng" selects, each with "Tất cả";
    - "Sắp xếp theo" select;
    - direction select "Nhiều → ít" / "Ít → nhiều";
    - "Hiển thị" select: Top 10 / Top 20 / Top 50 / Tất cả;
    - counter "N / M".
  - **Accessibility:** visible labels on every control, keyboard operable.
  - **Style:** ui-dna (square, 1px border, mono numbers, no shadow, WCAG AA).
- [x] 3.3 Add a shared table-state wrapper or pattern:
  - loading;
  - error: "Không tải được dữ liệu" + "Thử lại" (re-fetch);
  - filtered-empty: "Không có dữ liệu khớp bộ lọc" + "Xoá bộ lọc" (resets search and filters only);
  - period-empty: the existing message.

## 4. Wire the tables

- [x] 4.1 Usage page and Overview.
  - **Switch:** `src/app/(dashboard)/dashboard/usage/page.js` and `src/shared/components/UsageStats.js` get the "Model: Khách gọi | Gốc" control, bound to the `modelView` URL parameter, default `requested`. It passes `modelView` to `/api/usage/stats`.
  - **Notes:** show "Trước ngày <requestedSince> chỉ có model gốc" when `requestedPartial` is set, and "Đang tính lại số liệu theo model khách gọi…" while the rebuild is running.
  - **Provider cell:** in the requested view the Model table's provider cell lists the providers, top 3 + "+N".
- [x] 4.2 Overview tables (`src/app/(dashboard)/dashboard/usage/components/UsageTable.js` + `UsageStats.js`).
  - **Toolbar:** add it per table, with namespaces `ov-model`, `ov-account`, `ov-key`, `ov-endpoint`.
  - **Sort fields:** requests, tokens, cost, last used.
  - **Grouped tables:** sort groups by their summed value and rows within a group by the same field.
  - **Headers:** header clicks write the same state; `aria-sort` goes on sortable headers.
  - **Old links:** the legacy `sortBy` / `sortOrder` are read once as the initial state.
- [x] 4.3 Users tab (`UserUsageTable.js`).
  - **Toolbar:** namespace `users`, default cost desc. Its search replaces the current one with the same fields; the "With requests" filter is kept.
  - **Sort fields:** requests, tokens, cost, last request (empty last).
  - **Rows:** Top N, plus the states.
- [x] 4.4 Providers tab (`ProviderUsageTable.js`).
  - **Toolbar:** namespace `providers`, default requests desc. Existing header sorting goes through the shared state, and headers carry `aria-sort`.
  - **States:** error + retry.
- [x] 4.5 Details tab (`RequestDetailsTab.js`).
  - **Switch and model:** the model switch; the model column shows the model per view; the detail panel shows both "Model khách gọi" and "Model gốc".
  - **Filter:** a "Model" filter fed by the API options.
  - **Sort:** "Thời gian" / "Tokens" / "Độ trễ" with direction, sent to the server and kept in the URL (namespace `details`).
  - **Existing filters:** kept. Pagination resets to page 1 when the filter or sort changes. ← (verify: every table has toolbar + loading/error/empty states; URL round-trips each table's state; header and toolbar stay in sync; no billing code touched)

## 5. Tests and checks

- [x] 5.1 Day blob: a new day records `req` with `complete: true`; requested maps keyed by the effective requested model; a null `requestedModel` falls back to the upstream model; an existing incomplete blob is not written into `req`.
- [x] 5.2 Rebuild:
  - the rebuilt day equals a raw recomputation (oracle);
  - running it twice, or after a simulated interruption, does not double count;
  - a row inserted between scan and commit is counted once;
  - days before the retention margin are not marked complete.
- [x] 5.3 `getUsageStats`:
  - the requested and upstream views have identical totals and `byProvider` for the raw and daily periods;
  - requested `byModel` groups a combo served by two upstreams into one row;
  - `requestedPartial` and `requestedSince` are reported for a mixed range.
- [x] 5.4 Request details: the backfill of `requestedModel` from data; filter per view; sort by tokens and latency in both directions with nulls last; HTTP 400 on a bad `sort` or `order` at the route level.
- [x] 5.5 `tableQuery`: search case-insensitivity; filters; ties by name; empty values last in both directions; Top N; URL read/write round-trip with namespaces and the legacy `sortBy` / `sortOrder` fallback.
- [x] 5.6 Run `npm test`, `npm run lint` and `npm run build`, all passing. Confirm no file under billing/pricing (`pricingRepo`, `chargeSync`, `calculateCostNano`) changed. ← (verify: full suite green; build passes; diff touches no billing code)

## 6. Verify round 1 fixes

- [x] 6.1 Client-chosen model names (`__proto__`, `constructor`, …) in every map (design D4 "Client-chosen names"):
  - prototype-less maps for the in-memory ones (stats, per-owner and per-key summaries, pending counters, provider summary);
  - own-property helpers (`ownGet` / `ownSet`) for blob maps parsed from JSON (`addToCounter`, `tallyProvider`);
  - `Map` grouping and own-property lookups on the client (`UsageStats`, `tableQuery`).
- [x] 6.2 Rebuild reconciliation (design D3): the commit compares the counted requests and tokens with the day totals, and marks a mismatching day `unrecoverable` (never rescanned, upstream fallback). The read path returns `upstreamOnlyDays`, `upstreamOnlyIsPrefix` and the corrected `requestedSince`; the note names the days when they are not a prefix. A day completed before a later wipe keeps counting, consistent with its upstream maps (documented).
- [x] 6.3 Details search: Unicode case folding in JS over the capped table, ids passed back through `json_each` (works on every adapter).
- [x] 6.4 Providers "Lần dùng cuối": `lastUsed` from raw rows and from the rollup (`usageRollupProvider.lastTs`; hours rolled without it are filled in place, see 7.2 and 8.1); sort option and column.
- [x] 6.5 Totals: Providers and Users show the whole-period totals ("Tổng kỳ") and, when rows are hidden, the shown totals separately.
- [x] 6.6 Stats cache keyed by the rebuild generation; retry when it moves during a computation, otherwise `requestedBackfill.stale`; the client refreshes while `running` or `stale`.
- [x] 6.7 In-memory "all days resolved" flag skips the day listing; `invalidateRequestedBackfill()` for writers of incomplete blobs.
- [x] 6.8 In-flight highlight shown in the upstream view only (documented); expression index `idx_rd_effmodel` used by the requested-model filter and list; `q` in the spec's API list.
- [x] 6.9 Tests: model-name regression (write path, rebuild, read paths, Users and key summaries, pending counters, `tableQuery`), wipe before and after the rebuild, the all-resolved flag, provider `lastUsed` (raw, rollup, re-roll), the stats route after a rebuild, Unicode search, the index plan.
- [x] 6.10 Run `npm test`, `npm run lint` and `npm run build`; confirm no billing or pricing file changed.

## 7. Verify round 2 fixes

- [x] 7.1 Rebuild token sums are no longer rounded (they match the writer exactly); the reconciliation compares requests exactly and token sums within a floating-point tolerance. Test: a 3.5-token day rebuilds as complete.
- [x] 7.2 Provider `lastTs` is filled in place (`scheduleProviderLastTsBackfill`, one hour per turn, once per process) instead of invalidating the rollup; the summary reads the newest unfilled hour raw meanwhile. Test: key and owner-peak rollups and the watermark survive; exact `lastUsed` with hours unfilled.
- [x] 7.3 Wording aligned: "Tổng đang hiển thị" on Users; the upstream-only note lists the five most recent days plus "và N ngày trước đó" (spec, design and code).
- [x] 7.4 The rebuild poll is scheduled 10 s after a response arrives, never while a fetch runs.
- [x] 7.5 `scope="col"` on sortable headers.
- [x] 7.6 Details search scans in slices of 2000 rows that yield; design D5 states the real cap (default 1000, unbounded). Test: one-row slices give the same results.
- [x] 7.7 design.md Risks: endpoint filled in by a duplicate save; per-process rebuild generation.
- [x] 7.8 Run `npm test`, lint (excluding `.claude/**`) and `npm run build`.

## 8. Verify round 3 fixes

- [x] 8.1 Unfilled provider hours are read with ONE grouped query per distinct hour for all providers (`hourLastTsByProviderSync`), yielding between hours; the backfill step uses the same query. Test: several providers whose newest unfilled hours differ, two sharing an hour.
- [x] 8.2 The token reconciliation tolerance is the summation error of the day's rows (`2 × n × 2^-52 × |total|`, floor 1e-9). Tests: many fractional counts rebuild as complete; an integer day off by one token is unrecoverable.
- [x] 8.3 Task wording current (2.1 index name, 6.4 in-place fill).
- [x] 8.4 Providers totals sum integer `costNanoUsd` and convert once for display.
- [x] 8.5 The search slice size is at least one row (0, negative or non-number fall back). Test added.
- [x] 8.6 Run the change's tests, `npm test`, lint (excluding `.claude/**`) and `npm run build`.
