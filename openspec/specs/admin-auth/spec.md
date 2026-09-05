# admin-auth Specification

## Purpose
Authenticates administrators and protects the dashboard + admin API with a cookie-based session, plus sanitization of sensitive request headers before they are stored in request details.
## Requirements
### Requirement: login flow returns JSON with cookie

`POST /api/auth/login` MUST accept a JSON body `{"password":"..."}` and MUST return `{"success":true,"mustChangePassword":false}` on success, setting the `auth_token` cookie. On failure it MUST return 401/403/429 JSON.

#### Scenario: valid password

- **WHEN** the request body contains the correct password (matching the stored hash, or the `INITIAL_PASSWORD`/default `123456` when no hash is stored)
- **THEN** the response is 200 `{"success":true,"mustChangePassword":false}` with a `Set-Cookie: auth_token=<jwt>; HttpOnly; SameSite=Lax; Path=/...` header

#### Scenario: invalid password

- **WHEN** the password is wrong
- **THEN** the response is 401 with `{"error":"...remainingBeforeLock attempt(s) left...", "remainingBeforeLock":<n>}` and increment the fail counter for that IP

#### Scenario: default password on a remote client must be changed

- **WHEN** no password hash is stored AND `INITIAL_PASSWORD` is not set AND the request is non-local (not from the loopback/trusted peer)
- **THEN** the response is 403 `{"success":false,"error":"...must be changed...", "mustChangePassword":true}` and **no JWT cookie is issued** (prevents remote attackers using the public default password to authenticate and disable auth)

### Requirement: login rate limiter

A per-IP progressive lockout MUST throttle brute-force attempts, in-memory (resets on process restart).

#### Scenario: progressive lockout

- **WHEN** an IP accumulates 5 failed logins
- **THEN** subsequent login attempts from that IP return 429 `{"error":"...","retryAfter":<seconds>, "resetHint":"..."}` with a `Retry-After: <seconds>` header
- **AND** the lock durations escalate as failures recur: 30s, 2m, 10m, 30m
- **WHEN** a login from a locked IP succeeds (after the lock expires) or the IP has no failures for 1 hour
- **THEN** the counter resets (`recordSuccess` clears the IP)

### Requirement: auth status endpoint

`GET /api/auth/status` MUST return the current session state and configured auth modes (for the login UI).

#### Scenario: authenticated vs unauthenticated

- **WHEN** called with a valid `auth_token` cookie
- **THEN** it returns `{"authenticated":true, "displayName":"...", "loginMethod":"Password"|"OIDC"|"SAML", "requireLogin":bool, "authMode":"...", "hasPassword":bool, ...}`
- **WHEN** called with no/invalid cookie
- **THEN** it returns `{"authenticated":false, ...}` with the same shape and configured flags (oidcConfigured, samlConfigured), and never errors

### Requirement: logout clears the session

`POST /api/auth/logout` MUST clear the `auth_token` cookie and MUST return `{"success":true}`.

#### Scenario: logout

- **WHEN** a logged-in client POSTs `/api/auth/logout`
- **THEN** the `auth_token` cookie is expired and the response is 200 `{"success":true}`

### Requirement: tunnel access guard

Login via a tunnel (Tailscale/Cloudflare/etc. host) MUST be blocked unless explicitly enabled.

#### Scenario: tunnel dashboard disabled

- **WHEN** the request host matches a configured tunnel/tailscale URL AND `tunnelDashboardAccess` setting is not `true`
- **THEN** the login response is 403 `{"error":"Dashboard access via tunnel is disabled"}`

### Requirement: SSO configuration detection

The auth status MUST report whether OIDC/SAML are configured so the login page can show SSO buttons, but this phase only detects configuration — full SSO login flows are out of scope.

#### Scenario: SSO flags in status

- **WHEN** `/api/auth/status` is called
- **THEN** the response includes `oidcConfigured:bool`, `samlConfigured:bool`, `oidcLoginLabel`, `samlLoginLabel`, `authMode`, `ssoType`
- **AND** when `authMode` is `sso`/`saml`/`oidc` and the respective SSO is configured, password login returns 403 `{"error":"Password login is disabled. Use <SSO> sign in."}` (so a frontend can route to the SSO flow, even though the flow itself is a later phase)

### Requirement: Session cookie

The system SHALL use an `httpOnly`, signed JWT cookie for sessions. The cookie MUST NOT be readable by client-side JavaScript. Tampered or expired cookies are rejected and the request treated as unauthenticated.

#### Scenario: Cookie present and valid

- **WHEN** a browser sends a valid admin session cookie to `/dashboard`
- **THEN** the request is treated as authenticated and the dashboard renders

#### Scenario: Cookie tampered

- **WHEN** a browser sends a cookie whose signature does not verify
- **THEN** the server treats the request as unauthenticated (redirects to login)

#### Scenario: Cookie expired

- **WHEN** a browser sends a cookie past its expiry
- **THEN** the server treats the request as unauthenticated

### Requirement: RequireAdmin guard

The system SHALL guard all `/api/*` and admin routes with a `RequireAdmin` check that rejects requests lacking a valid admin session. Unauthenticated requests to a guarded `/api/*` route return 401 JSON `{"error":"Unauthorized"}`. Unauthenticated requests to a non-`/api` HTML page route redirect to `/login`.

#### Scenario: Guarded API route without session

- **WHEN** an unauthenticated request reaches any `/api/*` route
- **THEN** the server returns 401 JSON `{"error":"Unauthorized"}`

#### Scenario: Guarded route without session

- **WHEN** an unauthenticated request reaches any non-`/api` HTML page route
- **THEN** the server redirects to `/login`

#### Scenario: Guarded route with session

- **WHEN** an authenticated admin session reaches a guarded route
- **THEN** the request proceeds to the handler

### Requirement: Logout

The system SHALL provide a logout action that clears the session cookie and redirects to `/login`.

#### Scenario: Logout clears session

- **WHEN** an admin clicks logout
- **THEN** the server clears the cookie and redirects to `/login`; subsequent `/dashboard/*` requests redirect to login

### Requirement: Sensitive request-header redaction

The system SHALL redact sensitive headers (`authorization`, `x-api-key`, `cookie`, `token`, `api-key` — matched case-insensitively by substring) from stored request details before persistence.

#### Scenario: Authorization header redacted

- **WHEN** a proxied request carries `Authorization: Bearer sk-…` and its headers are stored in `requestDetails`
- **THEN** the stored `authorization` header is removed (not present in the stored `request.headers`)

#### Scenario: Custom sensitive header redacted

- **WHEN** a proxied request carries `X-API-KEY: foo` and its headers are stored
- **THEN** the stored `x-api-key` header is removed

#### Scenario: Non-sensitive header kept

- **WHEN** a proxied request carries `content-type: application/json`
- **THEN** the stored `content-type` header is preserved

### Requirement: Password hashing

The system SHALL hash admin passwords with argon2 (not bcrypt, not plaintext). Stored credentials MUST be argon2 hashes; verification re-hashes/verifies with argon2.

#### Scenario: Stored password is argon2

- **WHEN** an admin password is stored
- **THEN** the stored value is an argon2 hash string, not plaintext and not a bcrypt hash

### Requirement: Password reset over JSON

`POST /api/auth/reset-password` MUST accept `{"currentPassword":"...","newPassword":"..."}` (or `{"newPassword":"..."}` when no password hash exists, i.e., completing first-run setup) and, after verifying `currentPassword` against the stored hash when one exists, MUST hash the new password with argon2, store it, and return `{"success":true}`. On a wrong `currentPassword` it MUST return 401 `{"error":"Current password is incorrect"}`. It MUST require auth when a password is already set; when no password is set it completing the must-change-password flow, it MUST accept the request from an already-issued one-time session OR follow the Node first-run reset path. A new `auth_token` cookie MUST be issued after a successful reset (fresh token) so the client is authenticated going forward.

#### Scenario: first-run password set
- **WHEN** no password hash is stored and `POST /api/auth/reset-password` with `{"newPassword":"strong"}` is called
- **THEN** the new password is hashed (argon2) and stored, and the response is 200 `{"success":true}` with a fresh `Set-Cookie: auth_token=<jwt>`

#### Scenario: change existing password wrong current
- **WHEN** a password hash exists and `POST /api/auth/reset-password` with `{"currentPassword":"wrong","newPassword":"x"}` is called
- **THEN** the response is 401 `{"error":"Current password is incorrect"}` and the stored hash is unchanged

#### Scenario: change existing password success
- **WHEN** `POST /api/auth/reset-password` with `{"currentPassword":"correct","newPassword":"new"}` is called and `currentPassword` verifies
- **THEN** the new password is hashed and stored, and the response is 200 `{"success":true}` with a fresh `auth_token` cookie

