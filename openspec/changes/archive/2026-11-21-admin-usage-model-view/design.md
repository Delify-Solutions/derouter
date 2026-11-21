## Context

See proposal.md for the motivation and specs/admin-usage-views/spec.md for the behaviour.

**Where the data comes from today:**
- The Overview (`getUsageStats` in `src/lib/db/repos/usageRepo.js`) reads two sources:
  - per-day JSON blobs in `usageDaily`, for 7 / 30 / 60 days;
  - raw `usageHistory` rows, in 3-hour slices (`forEachUsageSlice`), for today / 24 h.
- The blob writer (`aggregateEntryToDay`, around line 177) keys `byModel`, `byAccount`, `byApiKey` and `byEndpoint` by the upstream `model` and provider.
- The requested model is stored only in `usageHistory.meta.$.requestedModel` and in `requestDetails.data.requestedModel`.
- `GET /api/usage/stats` wraps `getUsageStats(period)` in an SWR cache keyed `usage:stats:${period}`.
- `requestDetails` is capped by `observabilityMaxRecords` (default 1000, `settingsRepo`; an admin setting with no upper bound). Its listing orders by `timestamp DESC` only.

**Performance constraint:** see memory `usage-dashboard-perf` and the `usageRollup.js` header. No dashboard read or background job may hold the event loop for a long synchronous scan. Large reads go in slices that yield (`forEachUsageSlice`, `scheduleRollup`), and every pre-aggregated figure is checked against the raw read as an oracle.

**Effective requested model:** `COALESCE(NULLIF(meta.requestedModel, ''), NULLIF(model, ''), 'unknown')`. This is the rule `usageRollup.js` already uses for the Users tab, so both tabs agree.

## Goals / Non-Goals

**Goals:**
- The requested view is as fast as today's upstream view for every period.
- Requested figures equal a raw recomputation for every day whose raw rows are kept.
- The toolbar is one component plus one pure helper, reused by four tables.

**Non-Goals:**
- Changing pricing, charging or the recorded cost of any request.
- Requested-model figures for days whose raw rows were pruned. This is impossible: the data no longer exists.
- Changing `/dashboard/stats`, the customer area or the hourly rollup tables.

## Decisions

### D1. Requested aggregates live in the same day blob, under `day.req`

Each `usageDaily` blob gains:

```
req: {
  complete: true,
  byModel:   { "<reqModel>": counter + providers: { "<provider>": requests } },
  byAccount: { "<reqModel>|<connectionId>": counter + provider },
  byApiKey:  { "<keyIdent>|<reqModel>": counter + apiKeyId/apiKey meta like byApiKey },
  byEndpoint:{ "<endpoint>|<reqModel>": counter },
}
```

- The counters use exactly the value extraction of the existing upstream maps (`addToCounter` with the same `vals`).
- `keyIdent` follows the existing rule: `id:<apiKeyId>`, else the raw string for an unowned key, else `local-no-key`.

**Alternatives rejected:**
- A new rollup table keyed by (hour, requested model, provider, connection, key, endpoint). It would be a second pre-aggregation of the same rows, with its own watermark, invalidation and prune. Its cardinality per hour would also be far larger than the blob's per-day maps.
- Computing the requested view from raw rows on every load. This is exactly the 12 s stall the rollup work removed.

### D2. Write path: only into a complete `req`

`saveRequestUsage` updates the blob in its existing transaction:
- **New blob** (first request of the day after deploy): created with `req.complete = true`, and the request is added to both the upstream and the requested maps.
- **Existing blob with `req.complete === true`:** the request is added to both.
- **Existing blob without it** (the deploy day, or older days not rebuilt yet): only the upstream maps are updated. The rebuild (D3) counts the request from the raw row instead.

This makes "exactly once" hold without any lock beyond the existing synchronous transaction.

### D3. Rebuild: sliced scan + delta in one sync transaction

`scheduleRequestedBackfill(db)` follows the `scheduleRollup` pattern: one loop per process, started from a microtask, yielding between slices. It is triggered (fire and forget) by `getUsageStats` whenever the requested view is asked for, and once at module first use.

1. **Pick the days.** Eligible days are blob days with `req.complete !== true` whose local-day start is at or after the retention cut-off plus one day:
   - the cut-off is `now − LOG_RETENTION_DAYS days`;
   - the extra day is margin, because the probabilistic prune moves the cut-off while the rebuild runs.

   Days are processed newest first, so the periods the admin views most become exact first.
2. **Snapshot.** For one day, record `maxId = MAX(id) FROM usageHistory` before the scan.
3. **Scan.** Read the day's rows with `id <= maxId` through `forEachUsageSlice`. Inside SQLite, group them by (effective requested model, provider, connectionId, apiKey, apiKeyId, endpoint), with SUM expressions that mirror `aggregateEntryToDay` exactly: `prompt_tokens || input_tokens`, `completion_tokens || output_tokens`, `cached_tokens || cache_read_input_tokens` (a 0 falls through, as in JS `||`), and cost = `costNanoUsd`, else `round(cost × 1e9)`. A rebuilt day must then equal the upstream maps of the same blob when summed. Merge the groups in JS into fresh `req` maps.
4. **Commit, in one synchronous transaction:**
   - if the day's start has fallen behind the retention cut-off, stop (the prune may have removed rows; status `out-of-retention`);
   - re-read the blob;
   - if `req.complete` (or `req.unrecoverable`) is already true, do nothing (idempotent: another loop or a restart finished it);
   - otherwise, aggregate the day's rows with `id > maxId` (the small delta written during the scan) into the maps;
   - **reconcile:** the requests, prompt, completion and cached tokens counted by scan + delta must equal the blob's own day totals (`day.requests`, `day.promptTokens`, …). The rebuild adds token sums exactly as the writer does, never rounding them (a fractional count such as 3.5 stays 3.5); requests must match exactly and token sums within the rounding error of adding the day's n rows on each side, `2 × n × 2^-52 × |total|` (floor 1e-9), because SQLite and JS may add the same fractional values in a different order. Integer sums below 2^53 are exact on both sides, so an integer-only day must match exactly, and a real difference (at least one token) is far above the tolerance. Cost is not compared: blobs written before integer cost existed seeded `costNanoUsd` from a rounded float total, so their integer can differ from the rows' sum without a row missing; the request count already moves whenever a row is missing;
   - if they match, write `req` with `complete: true`;
   - if they do not, raw rows were deleted (a customer's "Clear history", `deleteKeyUsageHistory`), never existed (the legacy JSON import) or fall on another local day (a time-zone change). The day is written as `req: { complete: false, unrecoverable: true, at, counted, expected }`: it is never scanned again, the writer leaves it alone (it only writes into a complete `req`), and the read path uses its upstream maps.

   Because the write path (D2) never touches an incomplete `req`, every row of the day is counted exactly once: either by the scan, by the delta, or (after completion) by the writer.

**Progress:** a module-level state `{ running, pendingDays, generation }` is exposed for the "Đang tính lại…" note. `generation` grows each time a day is resolved (complete or unrecoverable); the stats cache keys on it (D4).

**All days resolved:** once a loop has resolved every listed day without a failure, later triggers return at once instead of listing the days again (the listing runs `json_valid`/`json_extract` over up to 60 blobs). The request writer only creates complete days, so no day can become pending afterwards in that process; anything else that writes a blob without a complete `req` (an import, a test) calls `invalidateRequestedBackfill()`.

**Failures:** a failure logs one line, without secrets, and leaves the day incomplete. The next trigger retries it.

**A day completed before a later wipe** keeps its requested maps unchanged: they go on counting the wiped rows exactly like the day's upstream maps and totals, which a wipe never adjusts either. Both views therefore stay consistent with each other and with the totals; neither reflects the wipe.

### D4. Read path

`getUsageStats(period, { modelView })` — the repository default is `upstream`, so callers that do not choose (`/api/usage/history`, existing tests) keep their exact output; the admin route defaults to `requested`:
- **Daily path:**
  - for each day blob, if `modelView === "requested"` and `day.req?.complete`, read `day.req.*` into the same output shapes (`byModel`, `byAccount`, `byApiKey`, `byEndpoint`);
  - otherwise (not rebuilt yet, unrecoverable, or past retention) read the upstream maps. In the requested view, the upstream model name is then used as the row's model (the fallback);
  - `upstreamOnlyDays`: the days in range read through the fallback, oldest first; `requestedPartial = true` when there is one;
  - `requestedSince`: the first day of the newest unbroken run of days with requested figures (null when the newest day in range has none), and `upstreamOnlyIsPrefix`: whether the fallback days are exactly the days before it. The page shows "Trước ngày <requestedSince> chỉ có model gốc" only then; otherwise it names the fallback days, the five most recent, followed by "và <N> ngày trước đó" when there are more ("Ngày 18/11/2026, 20/11/2026 chỉ có model gốc"), so a day in the middle of the range is never hidden.
- **Raw (today / 24 h) path:** the GROUP BY adds the effective requested model expression. In the requested view the rows are keyed by it.
- **Fields:** the returned row objects keep the field names the UI already uses (`rawModel` holds the displayed model). The Model rows also carry a `providers` list, in descending request order.
- **Totals:** `byProvider`, the totals, `last10Minutes`, `recentRequests` and `pending` are computed exactly as today, whatever the view.
- **Last-used overlay:** the 48 h precise `lastUsed` overlay adds the effective requested model to its GROUP BY, and matches the requested keys in the requested view.
- **In-flight highlight:** the live pending counters are kept per upstream model (`model (provider)`); `trackPendingRequest` does not know the requested model. The highlight is therefore shown in the upstream view only; requested rows show none rather than an accidental match.
- **Client-chosen names (all maps):** model names come from the client (`__proto__`, `constructor`, `toString`…). Every map keyed by them is prototype-less (`Object.create(null)`: the stats maps, the per-owner and per-key summaries, the pending counters) or, for a blob map parsed back from JSON, read and written only through own-property helpers (`ownGet` / `ownSet` with `Object.defineProperty`). Such a name is then an ordinary row, and nothing is ever written onto `Object.prototype`. The client side does the same (`Map` for grouping, own-property lookups in `tableQuery`).

`GET /api/usage/stats` accepts `modelView` (anything else means `requested`). The SWR key is `usage:stats:${period}:upstream`, or `usage:stats:${period}:requested:g${generation}` with the rebuild generation (D3): a computation started before a day was resolved is stored under the old key and can never be served for the new one. When the generation moves while a computation runs, the route computes again under the new key (up to 3 times) and otherwise marks the response `requestedBackfill.stale`; the client keeps refreshing while `running` or `stale`, so its last response after the rebuild reflects every day. The SSE stream still pushes only in-memory pending state, so it is unchanged.

### D5. `requestDetails.requestedModel` column

- **Schema:** add `requestedModel: "TEXT"` and the expression index `CREATE INDEX IF NOT EXISTS idx_rd_effmodel ON requestDetails(COALESCE(NULLIF(requestedModel, ''), model))` to `TABLES` — the requested-view filter and model list use exactly that expression, so SQLite uses the index for both (a plain index on `requestedModel` could serve neither). Bump `SCHEMA_VERSION` 43 → 44. The change is additive, so no versioned migration is needed.
- **Backfill:** after the additive sync, run a one-off guarded statement:

  ```
  UPDATE requestDetails
     SET requestedModel = json_extract(data, '$.requestedModel')
   WHERE requestedModel IS NULL AND json_valid(data)
  ```

  It runs at most once per process. It runs once ever in practice: only rows written before the column existed match, and the table held at most `observabilityMaxRecords` (default 1000) of them, so one statement is acceptable. `migrate.js` has no post-sync hook, so it runs lazily on the first listing call.
- **Writer:** the flush writes the column.
- **Listing:** `getRequestDetails` gains:
  - `modelView` (repository default `upstream`, so the customer receipts route keeps its match; the admin route defaults to `requested`);
  - `q`, a free-text search over the model, requested model, provider and the owner snapshot (e-mail, display name, key name). SQLite's `lower()` / `LIKE` fold ASCII only ("Đức" would never match "đức") and a user-defined SQL function is not available on every adapter (bun:sqlite has none), so the matching ids are found in JS — Unicode case folding, NFC-normalised — over the rows the other filters keep, and passed back as one `id IN (SELECT value FROM json_each(?))` parameter. The cap defaults to 1000 rows but has no upper bound, so the scan reads 2000 rows at a time in `rowid` order and yields to the event loop between slices: however large the table, no single turn holds the loop for more than one slice;
  - `model`, matched against `COALESCE(NULLIF(requestedModel,''), model)` in the requested view and against `model` in the upstream view;
  - `sort` ∈ {time, tokens, latency} and `order` ∈ {desc, asc}.
- **Sort expressions:**
  - time = `timestamp`;
  - tokens = `COALESCE(json_extract(data,'$.tokens.prompt_tokens'), json_extract(data,'$.tokens.input_tokens'), 0) + COALESCE(json_extract(data,'$.tokens.completion_tokens'), json_extract(data,'$.tokens.output_tokens'), 0)`, NULL when both are absent;
  - latency = `json_extract(data,'$.latency.total')`.
  - Nulls go last via `ORDER BY (expr IS NULL), expr <dir>, timestamp DESC`.
- **Model options:** a `models` list (the distinct models of the view, at most 500) is returned with the listing for the filter.
- **Validation:** the route validates `sort` and `order` (HTTP 400 on anything else).

### D6. Shared toolbar = pure helper + presentational component

- **Pure helper** `src/shared/utils/tableQuery.js`:
  - `applyTableQuery(rows, { search, searchFields, filters, sortField, sortDir, top, nameOf, valueOf })` filters, sorts and cuts the rows, applying the tie and null rules from the spec;
  - `readTableQuery(searchParams, ns, defaults)` and `writeTableQuery(params, ns, state)` handle the URL, with namespaced keys (`<ns>.q`, `<ns>.sort`, `<ns>.dir`, `<ns>.top`, `<ns>.f.<name>`);
  - it uses relative imports only, so tests import it directly.
- **Component** `src/shared/components/TableToolbar.js`:
  - search input, filter selects, sort select, direction select, Top select, and a counter "N / M";
  - labelled controls, keyboard-only operable;
  - follows ui-dna: square, 1px border, mono numbers, no shadow.
- **Tables:**
  - The Overview's `UsageTable` currently reads `sortBy` / `sortOrder` from the URL. It moves to the namespaced keys of its table (`ov-model`, `ov-account`, `ov-key`, `ov-endpoint`).
  - The old `sortBy` / `sortOrder` parameters are still read once as the initial state, so old links keep working.
  - Header clicks write the same namespaced state, so header and toolbar always agree, and each sortable `<th>` carries `aria-sort`.
  - Grouped Overview tables sort their groups by the group's summed value, and sort the rows inside a group by the same field.
- **Server-sorted tables:** Users and Providers sort on the client; their data is already fully loaded. Details sorts on the server (D5), because it is paginated.
- **Providers "Lần dùng cuối":** `getProviderUsageSummary` returns each provider's `lastUsed`. The raw path takes the newest row timestamp; the rollup path reads a new `usageRollupProvider.lastTs` (the hour's newest request). Provider hours rolled before that column existed have no `lastTs`. They are filled in place (`scheduleProviderLastTsBackfill`): newest hour first, one hour per turn of the event loop, each from one indexed `GROUP BY provider` scan of that hour's raw rows, then an `UPDATE … WHERE lastTs IS NULL` of that hour's rows. Nothing is discarded: the key and owner-peak rollups (Users tab) and the watermark are untouched. It runs once per process; after a complete pass later calls are no-ops, since every new roll writes `lastTs`. While hours are still unfilled the summary stays exact: the rollup read also returns each provider's newest unfilled hour, and when that hour could hold a later request than the provider's filled ones, it is read from the raw rows. Providers are grouped by that hour and each distinct hour is read ONCE for all of them (`hourLastTsByProviderSync`: one `GROUP BY provider` scan of the hour on `idx_uh_ts` — provider is not in that index, so a per-provider query would rescan the hour), yielding to the event loop between hours. The backfill step uses the same query.
- **Totals:** a table's totals always cover the whole period ("Tổng kỳ"), whatever the search, filters or Top N; when those hide rows, a second line "Tổng đang hiển thị" sums the rows shown (Providers, Users).

### D7. States

Each table wraps its fetch with `{ loading, error, retry }`:
- error → "Không tải được dữ liệu" + "Thử lại", which re-runs the same fetch;
- empty after filtering → "Không có dữ liệu khớp bộ lọc" + "Xoá bộ lọc", which resets only the search and filters;
- empty period → the existing message.

## Risks / Trade-offs

- **[Blob size grows, up to roughly 2× per day]** → Maps are per day and keyed by low-cardinality tuples (the same order as today's maps). The blob is read only for the chosen period.
- **[The deploy day is incomplete until rebuilt]** → The rebuild starts on the first Overview load and goes newest first, so today is rebuilt first, normally within seconds. Until then the page shows the rebuild note and the fallback rows.
- **[Prune moves during a rebuild]** → The one-day margin when listing, and a re-check at commit: a day whose start has fallen behind the retention cut-off is not committed (status `out-of-retention`). The fallback is safe, because it never invents data.
- **[Rows deleted or missing before a rebuild]** (a customer's log wipe, the legacy import, a time-zone change) → The commit reconciles the counted requests and tokens with the day's own totals (D3) and marks a mismatching day unrecoverable instead of complete. It then uses its upstream maps, is listed in `upstreamOnlyDays`, and the page names it.
- **[Rows wiped after a day was completed]** → Nothing is adjusted: the requested maps keep counting the wiped rows exactly like the upstream maps and the day totals, which a wipe never touches. Both views stay consistent with each other and with the totals.
- **[Client-chosen model names such as `__proto__`]** → Prototype-less maps and own-property access everywhere such a name is a key (D4); a regression test covers the write path, the rebuild and the read paths.
- **[Provider `lastTs` on deploy]** → Filled in place in the background, one hour per turn (D6); no rollup is discarded, so the Users and Providers tabs keep reading the rollup, and the Providers "last used" stays exact meanwhile through a one-hour raw lookup.
- **[Sorting `requestDetails` with `json_extract`]** → The table is capped (default 1000), so the scan cost is bounded at the default. An index is not useful for JSON expressions. The search scan is sliced (D5); the COUNT and the sorted page remain single statements, as before this change.
- **[Endpoint filled in by a duplicate save]** → When a retried request is deduplicated, `saveRequestUsage` may fill in the stored row's missing endpoint without touching the day blob. A day rebuilt afterwards counts that request under the filled-in endpoint in its requested Endpoint table, while the upstream one keeps "Unknown"; only the endpoint attribution differs, never a total.
- **[Rebuild generation is per process]** → The stats cache keys on a counter held in memory. With several server processes, a day rebuilt by another process does not move this process's counter, so its cached requested figures can lag by at most the cache's stale window (15 s fresh, served stale up to 60 s while refreshing).
- **[URL parameter change for the Overview sort]** → The legacy `sortBy` / `sortOrder` are read as the initial state.

## Migration Plan

- **Deploy:** `SCHEMA_VERSION` 44 triggers the usual pre-migration backup, then the additive sync adds the `requestDetails` column and index and the `usageRollupProvider.lastTs` column, then the one-off backfill fills `requestedModel` on the first Details listing, and the first Providers load starts filling `lastTs` in place for the provider hours rolled before the column existed.
- **First Overview load:** starts the requested-day rebuild in the background.
- **Rollback:** the previous image ignores `day.req` and the new column, both additive. No data is removed.
