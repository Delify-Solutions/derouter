## Decisions

### D1. Aggregate in SQL, bucket in Vietnam time
`strftime/date(timestamp, '+7 hours', …)` buckets (week = Monday). The JS side
fills empty buckets with the same keys (`bucketKeyOf`), capped at 400 buckets;
ranges are capped at 400 days.

### D2. Owner of a request
New rows store it (`usageHistory.userId`, written by `saveRequestUsage`), so a
deleted key keeps its customer for good (the `deletedApiKeys` tombstone is purged
after 24 h). Older rows fall back to the key's owner, the legacy raw-key match,
the tombstone, then the account their charge was taken from
(`creditLedger.usageId`, indexed). No owner → "Admin / không có chủ".

### D3. Two money figures
"Giá trị" is the request's price (`usageHistory.costNanoUsd`); "Đã trừ credit" is
what customers were charged (ledger `charge` rows, after discounts, including the
part that became debt), joined to their request for model/provider and grouped by
the ledger's `userId` for customers. A request charged in several rows is counted
once in requests/tokens.

A charge is counted at its request's time (a back-charge is written later), the
same instant filtering and bucketing it. Charges on unlimited plans take no
credit and are left out of "Đã trừ credit".

### D4. Platform rows excluded
`provider = 'platform'` rows are refusals that moved no tokens.

### D5. Chart
Stacked bars of total tokens per bucket, top 6 groups by tokens in the reference
categorical order (validated light/dark; light-mode slots under 3:1 are relieved
by the legend and the table), the rest folded into "Khác" (neutral gray). One
filter block above everything it scopes; refetch keeps the previous render dimmed.

### D6. Retention and load
Request rows are pruned after `LOG_RETENTION_DAYS` (60 by default) while ledger
charges stay; the page says so when the range starts earlier. Queries run on the
request thread: filter options are cached 5 minutes per range and the page
debounces refetches.
