## Purpose
Detects when a request should have hit prompt cache but did not for a reason that is not the customer's own doing, and automatically credits back the extra the customer paid for it, within a daily cap, with full visibility for both the admin and the customer.

## ADDED Requirements

### Requirement: Cache-miss detection
A request SHALL be flagged as a cache miss candidate when both hold:
- its prompt shares a common prefix of at least 90% of its own prompt tokens with the immediately preceding request from the same API key (to the same provider, matched by requested model when both have one, otherwise by upstream model), within a bounded lookback window; and
- it reports zero cache-read tokens.

A request SHALL NOT be flagged when there is no immediately preceding request within the lookback window, or when the preceding request's prompt does not meet the 90% prefix threshold (a new conversation, or the customer's own edited or branched history) — this is the only disqualifying case; every other zero-cache-read request that does meet the prefix threshold is flagged, whatever the internal reason.
- **Eligibility:** only (provider, model) pairs whose pricing has a non-zero cached-input rate are considered — a pair that cannot be cached at all produces no detections.
- **One detection per request:** a given request is evaluated for this exactly once.

#### Scenario: Flagged — continuing conversation, no cache
- **WHEN** a request's prompt shares 95% of its tokens as a common prefix with the same key's immediately preceding request, and it reports 0 cache-read tokens
- **THEN** it is flagged as a cache-miss candidate

#### Scenario: Not flagged — context changed
- **WHEN** a request's prompt shares only 20% of its tokens as a common prefix with the same key's immediately preceding request
- **THEN** it is never flagged, regardless of its cache-read tokens

#### Scenario: Not flagged — partial cache
- **WHEN** a request meets the 90% prefix threshold but reports some non-zero cache-read tokens
- **THEN** it is not flagged (only a complete miss is in scope)

#### Scenario: Not flagged — model cannot cache
- **WHEN** the request's (provider, model) pair has a zero cached-input rate in pricing
- **THEN** it is never flagged

### Requirement: Refund amount
A flagged request's refund SHALL be `(input rate − cached-input rate) × overlapping token count`, using the pricing that actually applied to that request, and SHALL never exceed what that request was actually charged.

#### Scenario: Refund computed from the overlap
- **WHEN** a flagged request overlaps its predecessor by 10,000 tokens, its applicable input rate is $3/1M and cached-input rate is $0.30/1M
- **THEN** its refund is `(3 − 0.30) / 1,000,000 × 10,000` dollars

#### Scenario: Refund never exceeds the charge
- **WHEN** a flagged request's computed refund would exceed what it was charged
- **THEN** the refund is capped at the full charged amount

### Requirement: Daily capped auto-refund
Once a day, for each user with at least one flagged, not-yet-resolved detection, the system SHALL sum their flagged refunds and credit them automatically up to an admin-configured daily cap per user. Detections beyond the cap for that user that day SHALL remain pending for admin approval instead of being credited or discarded.
- **Posting:** an auto-refund posts a `creditLedger` row of kind `refund` for the amount credited, reversing into the same plan/window the original charge drew from, idempotent per request (crediting the same request's miss twice SHALL never happen even if the sweep runs more than once).
- **Default cap:** the default daily cap is $10 per user, admin-configurable.
- **Never silently dropped:** a detection that does not fit under the day's remaining cap SHALL stay visible (to the admin, pending approval) rather than disappearing.

#### Scenario: Under the cap
- **WHEN** a user's flagged detections for the day total $3 and the cap is $10
- **THEN** all of them are auto-refunded that day

#### Scenario: Over the cap
- **WHEN** a user's flagged detections for the day total $14 and the cap is $10
- **THEN** $10 is auto-refunded and the remaining $4 of detections stay pending for admin approval

#### Scenario: Re-running the sweep does not double-refund
- **WHEN** the daily sweep is run twice for the same day
- **THEN** no request is refunded more than once

### Requirement: Admin review page
A dedicated admin page SHALL list every detection (auto-refunded, pending, and any the admin has rejected), filterable by user, sortable, with the shared toolbar conventions used elsewhere in the admin usage tables (search, sort, Top N, URL state). It SHALL show aggregate statistics for the chosen period: number of detections, amount auto-refunded, amount still pending.
- **Approve a pending detection:** credits it immediately as its own `refund` ledger row, independent of that day's cap.
- **Reject a pending detection:** marks it rejected; it is never credited.
- **No internal cause exposed:** the page SHALL NOT show which upstream connection/account served either request, or any wording that names connection rotation, pool switching, or account identity as the cause. It may show neutral facts (timestamps, token counts, provider, model) for diagnosis.

#### Scenario: Filter by user
- **WHEN** the admin filters the page by a specific user
- **THEN** only that user's detections are listed, and the statistics reflect only them

#### Scenario: Approve a pending detection
- **WHEN** the admin approves a pending detection for $4
- **THEN** a `refund` ledger row for $4 posts immediately, independent of that user's daily cap for that day

### Requirement: Customer visibility
`/account/usage` SHALL mark a flagged request inline, reusing its existing cache-token columns. A customer-facing view SHALL list the customer's own refunds (amount and date), using the generic reason "Hệ thống không dùng được cache cho yêu cầu này" for every one, regardless of the internal cause. Each auto-refund or admin-approved refund SHALL also appear on `/account/ledger` as a `refund`-kind row.

#### Scenario: Customer sees a refund
- **WHEN** a customer's request was auto-refunded $0.05
- **THEN** their refunds view lists it with the generic reason, and `/account/ledger` shows a `+$0.05` row of kind "Hoàn credit"

#### Scenario: No internal cause leaked
- **WHEN** a customer opens their refunds view
- **THEN** no text anywhere names connection rotation, pool switching, or any specific account as the cause
