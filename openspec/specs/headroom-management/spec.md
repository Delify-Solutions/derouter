# headroom-management Specification

## Purpose
Headroom process management: start/stop/status/restart, the extras config, and a reverse-proxy passthrough at `/api/headroom/proxy/[...path]`, plus the headroom dashboard UI.
## Requirements
### Requirement: Headroom routes over JSON and proxy passthrough

The Rust backend MUST serve the headroom routes, all requiring auth (401 JSON without cookie) except the proxy passthrough which forwards to the headroom service: `GET /api/headroom/status`, `GET /api/headroom/extras`, `POST /api/headroom/start`, `POST /api/headroom/stop`, `POST /api/headroom/restart`, `ANY /api/headroom/proxy/{*path}` (forward the request to the headroom service and return its response). The state routes MUST return `{ok, status?, error?}`.

#### Scenario: headroom status
- **WHEN** `GET /api/headroom/status` is called authenticated
- **THEN** the response reports whether headroom is running

#### Scenario: headroom proxy passthrough
- **WHEN** a request reaches `/api/headroom/proxy/<path>` (any method)
- **THEN** the server forwards it to the headroom service and returns that service's response (status, headers, body)

### Requirement: Headroom page in TypeScript

The headroom dashboard page MUST be converted to `.tsx` with typed props, calling Rust via the typed apiClient.

#### Scenario: headroom page type-checks
- **WHEN** `npx tsc --noEmit` runs
- **THEN** the headroom page reports 0 errors

