# pxpipe-management Specification

## Purpose
Pxpipe process management routes (start/stop/status/logs/install/stats/restart) and the pxpipe dashboard UI.
## Requirements
### Requirement: Pxpipe routes over JSON

The Rust backend MUST serve the pxpipe routes as JSON, all requiring auth (401 JSON without cookie): `GET /api/pxpipe/health`, `GET /api/pxpipe/status`, `GET /api/pxpipe/stats`, `GET /api/pxpipe/logs`, `POST /api/pxpipe/start`, `POST /api/pxpipe/stop`, `POST /api/pxpipe/restart`, `POST /api/pxpipe/install`. Each MUST drive the pxpipe process (or report its state) and return `{ok, status?, logs?, error?}`. Process/action errors MUST be JSON, not 500 HTML.

#### Scenario: start pxpipe
- **WHEN** `POST /api/pxpipe/start` is called authenticated
- **THEN** the pxpipe process is started and the response is `{ok:true, status:"running"}`

#### Scenario: pxpipe logs
- **WHEN** `GET /api/pxpipe/logs` is called authenticated
- **THEN** the response is the recent pxpipe log lines

### Requirement: Pxpipe page in TypeScript

The pxpipe dashboard page (PxpipeClient) MUST be converted to `.tsx` with typed props, calling Rust via the typed apiClient.

#### Scenario: pxpipe page type-checks
- **WHEN** `npx tsc --noEmit` runs
- **THEN** the pxpipe page reports 0 errors

