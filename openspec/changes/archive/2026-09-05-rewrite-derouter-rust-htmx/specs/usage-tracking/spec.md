## Purpose

Tracks and displays request usage for admins: an Overview tab (aggregate stats), a Keys tab (per-key table with limits, peak TPM, and per-model breakdown), and a Details tab (per-request rows + a drawer with optional raw payloads). Request-detail storage is buffered.

## ADDED Requirements

### Requirement: Usage dashboard tabs

The system SHALL provide an admin usage page with three tabs — Overview, Keys, Details — switchable without a full page reload. Switching a tab fetches that tab's content as an HTML fragment and swaps it into the page; the active-tab CSS state is held client-side.

#### Scenario: Switch to Keys tab

- **WHEN** an admin clicks the "Keys" tab
- **THEN** the browser issues an `hx-get` for the keys fragment, swaps it in, and the Keys tab is marked active

#### Scenario: Overview is default

- **WHEN** an admin opens `/dashboard/usage`
- **THEN** the Overview tab content loads by default

### Requirement: Per-key usage table

The system SHALL show, per key, a table row with the masked key (`sk-…****last4` or `name − sk-…****last4`), the key's group, the RPM limit and live RPM, the TPM limit and live TPM, the budget (window spent vs `budgetUsd` with a progress indicator that turns red past 90%), the peak TPM in the selected window, request count, input/output/cache-read/cache-write tokens, cost, the number of allowed models (expandable into a per-model sub-table), and status/expiry.

#### Scenario: Keys table loads all keys

- **WHEN** an admin opens the Keys tab
- **THEN** every active key appears as a row with its masked key, limits, live RPM/TPM, budget progress, peak TPM, and totals

#### Scenario: Expand a key's per-model breakdown

- **WHEN** an admin clicks a key's models count
- **THEN** a sub-row appears beneath it with a per-model table (model, requests, input, output, cache, cost) and a totals row

#### Scenario: Budget near limit

- **WHEN** a key's window cost is 95% of its `budgetUsd`
- **THEN** the budget cell's progress indicator is red

### Requirement: Peak TPM

The system SHALL compute the peak TPM for a key within a selected time window as the maximum, over each 1-minute bucket in the window, of the sum of that minute's prompt + completion tokens for that key.

#### Scenario: Peak TPM from burst

- **WHEN** a key made requests totaling 35k tokens in minute 1, 50k in minute 2, and 10k in minute 3 over a 1-hour window
- **THEN** the peak TPM shown is 50000

### Requirement: Request details table

The system SHALL show per-request rows (timestamp, model shown as the combo name = `requestedModel`, status, latency, input/output/cache/reasoning tokens, message/tool counts, body size) filterable by key, status, provider, and date range.

#### Scenario: Filter details by key

- **WHEN** an admin selects a key in the Details tab filter and submits
- **THEN** only rows for that key appear (filtered server-side by `apiKey = ?`)

#### Scenario: requestedModel shown in details

- **WHEN** a row corresponds to a request that called combo `mygpt` resolved to `glm-5.3:pre`
- **THEN** the row's model column shows `mygpt` (`requestedModel`), not `glm-5.3:pre`

### Requirement: Request detail drawer with raw toggle

The system SHALL show a detail drawer for a row with summary fields and, when the admin opts in via a "Show raw" toggle, the actual stored `providerRequest`/`providerResponse`/`request`/`response` payloads. Without the toggle, those payload fields are presented as redacted.

#### Scenario: Open drawer without raw

- **WHEN** an admin opens a row's drawer and "Show raw" is off
- **THEN** the drawer shows summary fields and the raw payload sections are redacted (a `redacted` marker)

#### Scenario: Open drawer with raw

- **WHEN** an admin toggles "Show raw" on and opens the drawer
- **THEN** the drawer shows the actual stored `providerRequest`, `providerResponse`, `request`, and `response` bodies

### Requirement: Buffered request-details flush

The system SHALL write `requestDetails` rows via a buffered flush driven by a batch-size threshold and a background flush-interval timer — NOT one synchronous INSERT per request. The flush config (enabled, maxRecords, batchSize, flushIntervalMs, maxJsonSize) comes from settings with env-var fallbacks.

#### Scenario: Burst does not issue per-request INSERTs

- **WHEN** 50 requests complete within 100 ms and the batch size is 20
- **THEN** rows are written in batched flushes, not 50 individual INSERTs

#### Scenario: Config disable stops logging

- **WHEN** observability is disabled (settings + env both off)
- **THEN** no `requestDetails` rows are written and no flush occurs

#### Scenario: Max records cap

- **WHEN** `requestDetails` exceeds `observabilityMaxRecords`
- **THEN** the oldest rows are deleted to bring the count back to the cap
