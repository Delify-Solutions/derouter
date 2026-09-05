# usage-tracking Specification

## Purpose
Tracks and displays request usage for admins: an Overview tab (aggregate stats), a Keys tab (per-key table with limits, peak TPM, and per-model breakdown), and a Details tab (per-request rows + a drawer with optional raw payloads). Request-detail storage is buffered.
## Requirements
### Requirement: usage endpoints over JSON

Usage stats, request details, request logs, and the live stream MUST be served as JSON/SSE by the Rust backend.

#### Scenario: usage stats

- **WHEN** `GET /api/usage/stats` is called authenticated (optional date range params)
- **THEN** it returns aggregate usage (totals, byApiKey, byModel, chart data) as JSON

#### Scenario: request details with filters and raw toggle

- **WHEN** `GET /api/usage/request-details?apiKey=&provider=&model=&status=&startDate=&endDate=&page=&pageSize=&includeRaw=1` is called authenticated
- **THEN** it returns paginated request detail rows; when `apiKey` is provided, rows are filtered to that key; when `includeRaw=1` the `request`/`providerRequest`/`providerResponse`/`response` bodies are returned as stored (truncated), otherwise they are redacted to `{"redacted":true}`
- **AND** each row includes the masked `apiKey` when the stored `apiKey` field is populated

#### Scenario: request logs

- **WHEN** `GET /api/usage/request-logs` authenticated
- **THEN** it returns recent log entries as JSON

#### Scenario: usage stream

- **WHEN** a client connects to `/api/usage/stream` (SSE) authenticated
- **THEN** the server emits Server-Sent Events with live usage updates; the connection stays open until the client disconnects

#### Scenario: requestedModel preserved

- **WHEN** request-detail rows are returned
- **THEN** each row includes `requestedModel` (the bare combo name the client sent), distinct from the resolved `model` — matching the two-level fix invariant

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

### Requirement: Usage chart and history over JSON

`GET /api/usage/chart` MUST return time-series usage data (requests and tokens bucketed by interval over a date range) as JSON for the admin chart. `GET /api/usage/history` MUST return a chronological usage history list. Both MUST require auth (401 JSON without cookie).

#### Scenario: chart time series
- **WHEN** `GET /api/usage/chart?startDate=&endDate=&interval=1h` is called authenticated
- **THEN** the response is JSON with buckets `{timestamp, requests, inputTokens, outputTokens, cost}` suitable for charting

### Requirement: Per-key usage summary and logs over JSON

`GET /api/usage/key-summary` MUST return a per-key usage summary (totals per key, masked key, group) as JSON. `GET /api/usage/logs` MUST return recent log entries (a shape distinct from `request-logs`, used by the admin logs view). Both MUST require auth.

#### Scenario: key summary
- **WHEN** `GET /api/usage/key-summary` is called authenticated
- **THEN** the response lists each key with masked `apiKey`, `name`, `groupName`, totals (requests, tokens, cost), and window spend

### Requirement: Usage by provider over JSON

`GET /api/usage/providers` MUST return usage broken down by provider (per-provider request/token/cost totals and model breakdowns) as JSON. It MUST require auth.

#### Scenario: provider breakdown
- **WHEN** `GET /api/usage/providers` is called authenticated
- **THEN** the response lists each provider with totals and a per-model sub-breakdown

### Requirement: Per-connection usage over JSON

`GET /api/usage/{connectionId}` MUST return usage aggregated for the given provider connection as JSON; on an unknown `connectionId` it MUST return 404 `{"error":"Connection not found"}`. It MUST require auth.

#### Scenario: per-connection usage
- **WHEN** `GET /api/usage/<connectionId>` is called authenticated for a real connection
- **THEN** the response is the connection's totals and per-model breakdown

#### Scenario: unknown connection
- **WHEN** `GET /api/usage/<unknown-id>` is called
- **THEN** the response is 404 `{"error":"Connection not found"}`

### Requirement: Codex credit reset over JSON

`POST /api/usage/{connectionId}/codex-reset-credits` MUST reset the cached Codex credit counter for the given connection and return `{"success":true}`. On an unknown connection it MUST return 404. It MUST require auth.

#### Scenario: reset codex credits
- **WHEN** `POST /api/usage/<connectionId>/codex-reset-credits` is called authenticated for a Codex connection
- **THEN** the credit counter for that connection is reset and the response is 200 `{"success":true}`

