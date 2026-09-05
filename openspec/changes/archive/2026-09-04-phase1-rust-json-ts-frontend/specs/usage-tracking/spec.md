## MODIFIED Requirements

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
