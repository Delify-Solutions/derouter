## Purpose

The Rust backend serves the admin and authentication API as JSON over HTTP, with CORS and JWT-cookie auth, so a separate Next.js + TypeScript frontend can consume it as an API client.

## ADDED Requirements

### Requirement: JSON admin API responses

Admin and auth routes MUST return JSON bodies (`Content-Type: application/json`), not HTML fragments. Error responses MUST be JSON `{"error":"..."}` with appropriate HTTP status codes. Successful reads MUST return the resource shape the frontend expects.

#### Scenario: protected admin route without auth cookie
- **WHEN** a request to a `/api/admin` or dashboard JSON route arrives without a valid `auth_token` cookie
- **THEN** the response is HTTP 401 with a JSON body `{"error":"Unauthorized"}` (not an HTML redirect)

#### Scenario: JSON error on bad input
- **WHEN** a POST/PUT to an admin route has an invalid body (missing required fields, bad provider id, bad proxyPoolId)
- **THEN** the response is 400 (or 422 where applicable) with JSON `{"error":"<reason>"}`

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
