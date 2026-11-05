## Why

The owner wants token statistics in the admin: pick the period (hours, days,
weeks, months, a custom range) and break usage down per model, per provider and
per customer. The existing Usage page has fixed periods and no such breakdown.

## What Changes

- New admin page `/dashboard/stats` ("Thống kê"): presets (today, yesterday, 24h,
  7/30/90 days, this/last month) and a custom from/to in Vietnam time; bucket by
  hour, day, week (Monday) or month; break down by requested model, upstream
  model, provider or customer; filter by customer, provider, model.
- Totals (requests, errors, input/output/cached tokens, price, credit actually
  charged), a stacked token chart of the top 6 groups plus "Khác", a table per
  group with share, clicking a row filters by it, CSV export.
- `GET /api/stats/tokens` (admin) aggregates in SQL; index
  `creditLedger(kind, createdAt)`; schema v36.

## Capabilities

### New Capabilities
- `usage-analytics`: admin token statistics.

## Impact

- `src/lib/stats/tokenStats.js`, `src/app/api/stats/tokens/route.js`,
  `src/app/(dashboard)/dashboard/stats/*`, Sidebar, globals.css (chart tokens),
  schema index; `test/token-stats.test.js`.
