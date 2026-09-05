# rust-json-api Specification

## Purpose

The Rust backend serves the admin and authentication API as JSON over HTTP, with CORS and JWT-cookie auth, so a separate Next.js + TypeScript frontend can consume it as an API client.
## Requirements
### Requirement: JSON admin API responses

Admin and auth routes MUST return JSON bodies (`Content-Type: application/json`), not HTML fragments. Error responses MUST be JSON `{"error":"..."}` with appropriate HTTP status codes. Successful reads MUST return the resource shape the frontend expects. Every `/api/*` route — those from Phases 1-2 plus the Phase 3 cli-tools, mcp, media-providers, tunnel, pxpipe, translator, headroom, and full oauth (cursor/kiro/codex/etc. import) routes — MUST follow this same JSON + 401-on-missing-auth contract. Process/action errors and external-platform errors MUST be returned as JSON, not 500 HTML. SSE routes (`/api/mcp/{plugin}/sse`, `/api/translator/console-logs/stream`) return `text/event-stream`. The headroom proxy passthrough (`/api/headroom/proxy/{*path}`) forwards the upstream status/headers/body verbatim.

#### Scenario: protected admin route without auth cookie

- **WHEN** a request to any Phase 3 `/api/*` admin route arrives without a valid `auth_token` cookie
- **THEN** the response is HTTP 401 with a JSON body `{"error":"Unauthorized"}` (not an HTML redirect); `/api/health` remains the sole public exception

#### Scenario: JSON error on bad input

- **WHEN** a POST/PUT to a Phase 3 admin route has an invalid body (missing required fields, bad enum, unknown id)
- **THEN** the response is 400 (or 404 for unknown id, as Node does per-route) with JSON `{"error":"<reason>"}`

#### Scenario: platform error as JSON
- **WHEN** a Phase 3 route calls an external platform (tunnel/pxpipe/media voices/oauth import) and the platform returns an error
- **THEN** the response is JSON `{ok:false, error:"..."}` (or the wrapped shape), never a 500 with HTML or a panic

#### Scenario: SSE route content type
- **WHEN** a client connects to an SSE Phase 3 route (`/api/mcp/<plugin>/sse`, `/api/translator/console-logs/stream`)
- **THEN** the response `Content-Type` is `text/event-stream` and frames are valid SSE

### Requirement: CORS for the frontend origin

The Rust server MUST allow cross-origin requests from the Next.js frontend with credentials, so React can call `http://<rust>/api/...` from `http://<frontend>/`.

#### Scenario: preflight and credentialed request

- **WHEN** a request arrives with `Origin: http://localhost:3000` (or any origin listed in `CORS_ORIGIN` env)
- **THEN** the response includes `Access-Control-Allow-Origin: <origin>`, `Access-Control-Allow-Credentials: true`, and allows the `Cookie` header; OPTIONS preflight returns 204 with the allowed methods/headers
- **AND** when `CORS_ORIGIN` is unset, the default allowed origins are `http://localhost:3000` and `http://localhost:20127`

### Requirement: JWT cookie authentication

The server MUST issue a `auth_token` JWT (HS256, 24h expiry) as an httpOnly cookie upon valid login, and MUST validate it on protected routes.

#### Scenario: cookie attributes

- **WHEN** login succeeds
- **THEN** the `Set-Cookie` header sets `auth_token` with `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` only when the request is HTTPS (`x-forwarded-proto: https` or `AUTH_COOKIE_SECURE=true`)
- **WHEN** a protected route receives a cookie whose JWT fails verification or is expired
- **THEN** the response is 401 JSON `{"error":"Unauthorized"}`

