## Context

Caching tokens are already extracted per request (`open-sse/handlers/chatCore/requestDetail.js:28-79`) and `open-sse/utils/cacheEstimator.js` already fingerprints prompts and compares them for a common prefix (`commonPrefixBytes`/`commonPrefixLength`, `promptTextForCache`) to estimate cache when an upstream doesn't report usage — this change reuses that prefix-matching logic for a different purpose (miss detection, not estimation), not a second implementation of it.

Connection selection (`src/sse/services/auth.js:29-230`, `getProviderCredentials`) round-robins across a provider's connections globally, with no concept of "this customer's conversation" — confirmed as the most likely real-world cause of a flagged miss, but this change deliberately never asserts or displays that cause; detection is purely behavioral (prefix match + zero cache-read), not a trace of which connection served which turn.

`creditLedger` already declares a `refund` kind in its UI label map (`src/app/account/ledger/LedgerTable.js:16`, "Hoàn credit") that nothing inserts today — this change is its first writer. `creditLedger.usageId` already references `usageHistory.id` (`schema.js`, "usageHistory.id for `charge` rows"), so the original charge for a given request is found by `usageId` lookup, giving its `userPlanId` to reverse into.

## Goals / Non-Goals

**Goals:**
- Flag only misses the customer did not cause, using one clear, testable rule (90% prefix overlap + zero cache-read).
- Refund exactly the extra the customer paid, never more than the request cost.
- Keep the daily cap and admin-approval path from ever silently losing a detection.
- Never let any internal routing detail reach customer- or admin-facing text.

**Non-Goals:**
- No change to connection selection, round-robin, or any attempt to prevent the underlying cache miss from happening — this change only detects and compensates for it.
- No partial-cache refunds (some cache-read tokens but less than expected) — only a complete miss (zero cache-read) is in scope, per the locked requirement.
- No real-time/instant refund — refunds post once a day, by design (matches the product copy already approved: "hoàn lại vào cuối mỗi ngày").

## Decisions

### 1. Detection runs inline at request-logging time, not in a batch scan
Beside where `usageHistory`/`requestDetails` rows are written (`usageRepo.js`, `requestDetailsRepo.js`), after the row exists: look up the same API key's immediately preceding request to the same (provider, effective requested model) within a bounded lookback (default 6 hours, a tunable constant — long enough for a real pause in conversation, short enough that an old, unrelated session is not compared). Compute the prefix overlap between the two prompts using `cacheEstimator.js`'s existing `promptTextForCache`/`commonPrefixLength`. If overlap ≥ 90% of the current request's prompt tokens and its cache-read tokens are 0, insert a `cacheMissDetections` row with status `pending`.
Alternative considered: a nightly batch that re-scans the day's `requestDetails`. Rejected — inline detection is cheaper (one indexed lookup per request, no re-scan) and the project's day-blob/rollup machinery is for *aggregation*, not for first discovering individual events; a batch would need to do the same per-request prefix comparison anyway, just later and in bulk.

### 2. `cacheMissDetections` table
```
id              TEXT PRIMARY KEY
usageHistoryId  INTEGER NOT NULL UNIQUE   -- one detection per request; also creditLedger.usageId linkage
userId          TEXT NOT NULL
apiKeyId        TEXT
provider        TEXT NOT NULL
model           TEXT NOT NULL             -- upstream
requestedModel  TEXT
overlapTokens   INTEGER NOT NULL
refundNanoUsd   INTEGER NOT NULL          -- computed amount, pre-cap, never recomputed later
status          TEXT NOT NULL             -- 'pending' | 'auto_refunded' | 'approved' | 'rejected'
ledgerId        INTEGER                   -- set once a refund ledger row exists (auto or approved)
detectedAt      TEXT NOT NULL
resolvedAt      TEXT                      -- when it left 'pending'
adminNote       TEXT
```
`usageHistoryId UNIQUE` is the idempotency guard for detection itself (decision #1's "one detection per request"). Indexes: `(userId, detectedAt)` for the admin filter+sort and the customer's own view, `(status, detectedAt)` for the daily sweep's query.

### 3. Refund amount frozen at detection time
`refundNanoUsd` is computed once, at detection, using the pricing that applied to the original request (the same `resolvePrice` result already used for that request's `costNanoUsd` — re-resolve with the request's own recorded `provider`/`model`/`requestedModel`, not today's price, and read the request's own `costNanoUsd` to cap it). It never changes afterwards, same principle as `vendor-cost-profit`'s snapshot decision.

### 4. Daily sweep and cap, same shape as `startBillingJanitor`
A new module (e.g. `src/lib/billing/cacheMissRefund.js`) follows `src/lib/billing/expiry.js`'s exact shape (unref'd interval, re-entry guard, fail-open, `globalThis` singleton, registered from `src/shared/services/initializeApp.js`), but runs once per calendar day instead of every 5 minutes. Each run:
1. Groups `pending` detections by `userId`.
2. For each user, sums `refundNanoUsd` for detections with no ledger row yet; refunds in detection order up to the admin-configured daily cap (default $10/user/day, a new field alongside `stickyRoundRobinLimit` in `settingsRepo.js`); each refunded detection becomes its own `creditLedger` row (one row per detection, not one combined row — keeps the per-request `usageId` link intact for the ledger's existing "charge row shows the model" convention) with `kind: "refund"`, `requestKey` derived from the detection's `id` (idempotency against a rerun), crediting the same `userPlanId` the original charge (found via `creditLedger.usageId = usageHistoryId`) drew from.
3. Detections beyond the cap stay `pending` (not marked anything else) so they surface to the admin page and are picked up again the next run (still subject to that later day's cap, unless the admin approves them directly first).
Study `insertLedgerSync` and the plan-queue-billing credit/window-recompute path (`rebuildWindowsSync`'s "counters recomputed from the ledger" convention, cited by `userPlanWindows`'s own comment in `schema.js`) before writing the credit step — the ledger row is very likely sufficient on its own (the window counters already recompute from it), but confirm against that code rather than assuming.

### 5. Admin approve/reject bypasses the cap
Approving a `pending` row (admin page) posts its ledger row immediately, independent of that day's cap for that user — the cap only throttles the *automatic* path. Rejecting sets `status: 'rejected'`, `resolvedAt`, no ledger row, permanent (a rejected detection is not revisited by the sweep).

### 6. No internal-cause wording, enforced by construction
Every customer- and admin-facing string this change introduces is one fixed, generic sentence ("Hệ thống không dùng được cache cho yêu cầu này" / "Hệ thống không dùng được cache cho yêu cầu này" on the admin side too, or an admin-only neutral label like "Cache miss"). No field that could leak the cause (`connectionId`, a diagnosis string naming rotation) is ever sent to a customer-facing API response or rendered in a customer-facing or admin-facing UI string — admins get neutral facts only (timestamps, tokens, provider, model), per the spec's "No internal cause exposed" requirement. This is a constraint on every UI/API task, not a separate feature.

## Risks / Trade-offs

- **[Risk]** A 6-hour lookback window or the 90% threshold could mis-classify some real conversations (too strict: misses a genuine continuation after a longer pause; too loose: treats two unrelated short prompts as "the same conversation"). → **Mitigation**: both are named constants in one place, trivially tunable without a schema change; ship the stated defaults and let the admin page's own statistics (detections per day, refund totals) surface if they look wrong in practice.
- **[Risk]** Reversing into the "same `userPlanId`" the original charge used assumes that plan/window still exists and is still open; a plan that has since fully expired or been deleted leaves nowhere clean to credit back into. → **Mitigation**: fall back to crediting the user's currently active paying plan (same resolution the proxy already uses to charge a *new* request) when the original plan is gone; document this fallback explicitly in the ledger row's `meta`, and never fail the whole day's sweep for one user's unusual case — skip that one detection (leave it `pending`) and continue.
- **[Risk]** Computing `refundNanoUsd` by re-resolving `resolvePrice` with the request's own recorded fields could disagree with the number `costNanoUsd` was actually computed from, if pricing precedence logic itself changes between then and now. → **Mitigation**: this is exactly why decision #3 freezes `refundNanoUsd` at detection time, as close to request-logging as possible (not deferred to the daily sweep) — the gap between "charged" and "detected" is minimized to the same request-processing moment.

## Migration Plan

1. Add `cacheMissDetections` table and bump `SCHEMA_VERSION` (additive, no versioned migration needed — brand new table).
2. Add the daily cap field to `settingsRepo.js` with its stated default.
3. Ship detection (wired into request logging) before the sweep — detections can safely accumulate as `pending` with no sweep running yet.
4. Ship the sweep module, registered from `initializeApp.js`, following `expiry.js`'s registration line exactly.
5. Ship the admin page, then the two customer-facing surfaces (usage indicator, refunds page) — both only read data steps 1–4 already produce.
Rollback: disable the sweep's registration line to stop new auto-refunds without losing data; `cacheMissDetections` and the `refund`-kind ledger rows it already wrote are historical records, safe to leave in place.

## Open Questions

None — the owner already chose the auto-refund-with-daily-cap policy and the price-difference refund formula; every other parameter (90% threshold, 6-hour lookback, $10/day default cap) is a named, documented default the owner can adjust without reopening this design.
