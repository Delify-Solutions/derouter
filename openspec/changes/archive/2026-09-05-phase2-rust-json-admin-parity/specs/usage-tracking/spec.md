## ADDED Requirements

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
