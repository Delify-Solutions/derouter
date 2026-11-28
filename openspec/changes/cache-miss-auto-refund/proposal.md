## Why

Prompt caching lowers a customer's cost whenever a conversation continues with the same leading context. Today, when caching fails to kick in for a continuing conversation — most commonly because the router's connection-rotation picked a different upstream account than the previous turn, since prompt caching is tied to the specific upstream session — the customer is silently charged full price with no way to know it happened, and no credit comes back. The admin also has no visibility into how often or how much this costs customers.

## What Changes

- Detect, per request, whether it is a cache miss worth refunding: the request continues the same conversation as its immediately preceding request from the same key (its prompt shares at least 90% of its tokens as a common prefix with that previous request), yet reports zero cache-read tokens. A request whose prompt does NOT share that much of a prefix with the previous one (a genuinely new conversation, or the customer's own edited/branched history) is never flagged — only a miss not explained by the customer's own context change counts.
- Compute the refund as the exact extra the customer paid for not getting the cache discount: `(input rate − cached-input rate) × overlapping token count`, using the pricing that applied to that request, capped at what the request actually cost.
- Credit the refund once a day, per user, up to a daily cap; detections beyond the cap for that user that day wait for admin approval instead of posting automatically.
- Never reveal the router's internal cause (which upstream connection/account served the request, or that accounts rotate at all) in any customer-facing or admin-facing text — the shown reason is always the generic "hệ thống không dùng được cache cho yêu cầu này", regardless of the internal cause recorded for diagnostics.
- New admin page listing every detection, filterable by user, sortable, with aggregate statistics (detected count, auto-refunded amount, pending-cap amount) and a way to approve/reject a capped-pending row.
- Customer-facing: `/account/usage` marks a cache-missed request inline (reusing its existing cache columns); a new view lists the customer's own refunds, and each auto-refund posts to `/account/ledger` using the existing `refund` ledger kind.

## Capabilities

### New Capabilities
- `cache-miss-refund`: detects a cache miss not caused by the customer's own context change, computes and posts a capped daily refund to the customer, and gives the admin a dedicated review page.

### Modified Capabilities
- `customer-portal`: `/account/usage` gains a cache-miss indicator per row, a new customer-facing refunds view, and the already-existing `refund` ledger kind on `/account/ledger` gains its first real writer (it is declared in the UI today but nothing inserts it yet).

## Impact

- Schema: new `cacheMissDetections` table (`src/lib/db/schema.js`), `SCHEMA_VERSION` bump.
- Detection: a new module reusing `open-sse/utils/cacheEstimator.js`'s prefix-matching helpers (`commonPrefixLength`/`promptTextForCache`), run at the same point a request is logged (`src/lib/db/repos/usageRepo.js`, `src/lib/db/repos/requestDetailsRepo.js`).
- Refund posting: a new daily background sweep (same shape as `src/lib/billing/expiry.js`'s `startBillingJanitor`), writing `creditLedger` rows with `kind: "refund"` via the existing `insertLedgerSync` convention, reversing into the same `userPlanId`/window the original charge used (found via `creditLedger.usageId`).
- Admin UI: new page under `/dashboard` (registered in `src/lib/auth/adminPages.js`, linked in `src/shared/components/Sidebar.js`).
- Customer UI: `src/app/account/usage/AccountUsageTable.js`, a new `src/app/account/` view for refunds, `src/app/account/ledger/LedgerTable.js` (no code change needed there — it already renders `kind: "refund"` as "Hoàn credit").
- Settings: a new admin-configurable daily per-user refund cap.
