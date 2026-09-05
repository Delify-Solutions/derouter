## MODIFIED Requirements

### Requirement: JSON admin API responses

The Rust backend MUST serve the entirety of the admin, auth, and proxy API as JSON over HTTP, with no Node fallback. All `/api/*` admin routes (Phases 1-3) and all `/v1/*` proxy routes MUST be handled by the Rust server. The Node backend (`src/app/api/**`, `src/lib/**`, `src/sse/**`, `src/mitm/**`, `src/store/**`) MUST be removed; no `/api/*` or `/v1/*` request is served by Node. Admin and auth routes MUST return JSON bodies (`Content-Type: application/json`), not HTML fragments. Error responses MUST be JSON `{"error":"..."}` with appropriate HTTP status codes. Successful reads MUST return the resource shape the frontend expects. Process/action errors and external-platform errors MUST be returned as JSON, not 500 HTML. SSE routes (`/api/mcp/{plugin}/sse`, `/api/translator/console-logs/stream`) return `text/event-stream`. The headroom proxy passthrough (`/api/headroom/proxy/{*path}`) forwards the upstream status/headers/body verbatim.

#### Scenario: protected admin route without auth cookie

- **WHEN** a request to any `/api/*` admin route arrives without a valid `auth_token` cookie
- **THEN** the response is HTTP 401 with a JSON body `{"error":"Unauthorized"}` (not an HTML redirect); `/api/health` remains the sole public exception

#### Scenario: JSON error on bad input

- **WHEN** a POST/PUT to an admin route has an invalid body (missing required fields, bad enum, unknown id)
- **THEN** the response is 400 (or 404 for unknown id, as Node does per-route) with JSON `{"error":"<reason>"}`

#### Scenario: platform error as JSON
- **WHEN** a route calls an external platform (tunnel/pxpipe/media voices/oauth import) and the platform returns an error
- **THEN** the response is JSON `{ok:false, error:"..."}` (or the wrapped shape), never a 500 with HTML or a panic

#### Scenario: SSE route content type
- **WHEN** a client connects to an SSE route (`/api/mcp/<plugin>/sse`, `/api/translator/console-logs/stream`)
- **THEN** the response `Content-Type` is `text/event-stream` and frames are valid SSE

#### Scenario: Node backend removed
- **WHEN** the deployed services handle a request to any `/api/*` admin route or `/v1/*` proxy route
- **THEN** the responding process is the Rust backend (`derouter-rs`), and no Node process serves admin/proxy routes — the `src/app/api/**`, `src/lib/**`, `src/sse/**`, `src/mitm/**`, and `src/store/**` directories are absent from the deployment

#### Scenario: proxy endpoints behaviorally unchanged after Node removal
- **WHEN** a client sends a `/v1/chat/completions` request with a valid key+combo before and after the Node backend deletion
- **THEN** the response (status, headers, streamed body shape, usage logging) is identical, because the Rust executors already handled the request in Phase 3 and Node was only redundant fallback
