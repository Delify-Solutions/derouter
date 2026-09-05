## Purpose

The translator console: routes for sending/translate test requests, loading/saving translator configs, and streaming console logs, plus the translator dashboard UI. Used to test request/response shape translation across provider formats.

## ADDED Requirements

### Requirement: Translator routes over JSON/SSE

The Rust backend MUST serve the translator routes as JSON/SSE, all requiring auth (401 JSON without cookie): `POST /api/translator/send`, `POST /api/translator/translate`, `GET /api/translator/load`, `POST /api/translator/save`, `GET /api/translator/console-logs`, `GET /api/translator/console-logs/stream` (SSE for live console output). The send/translate routes MUST apply the format translation and return the translated request/response; load/save MUST persist the translator config.

#### Scenario: translate request
- **WHEN** `POST /api/translator/translate` with a request body and source/target formats is called authenticated
- **THEN** the response is the translated body in the target format

#### Scenario: console log stream
- **WHEN** a client connects to `/api/translator/console-logs/stream` authenticated
- **THEN** the server emits live console log events until disconnect

### Requirement: Translator page in TypeScript

The translator dashboard page MUST be converted to `.tsx` with typed props, calling Rust via the typed apiClient (and the SSE stream for console logs).

#### Scenario: translator page type-checks
- **WHEN** `npx tsc --noEmit` runs
- **THEN** the translator page reports 0 errors
