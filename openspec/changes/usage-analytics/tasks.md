## 1. Data

- [x] 1.1 `tokenStatsSync` / `parseStatsQuery` / bucket helpers; index `idx_cl_kind_ts`, schema v36
- [x] 1.2 `GET /api/stats/tokens` with filter options ← (verify: grouping by user follows deleted keys; split charges not double-counted; platform rows excluded)

## 2. Page

- [x] 2.1 `/dashboard/stats`: presets, custom range, granularity, breakdown, filters, KPIs, stacked chart, table with drill-down, CSV
- [x] 2.2 Sidebar entry; chart colour tokens light/dark

## 3. Checks

- [x] 3.1 `test/token-stats.test.js`; full suite, lint, build; live screenshots light/dark
