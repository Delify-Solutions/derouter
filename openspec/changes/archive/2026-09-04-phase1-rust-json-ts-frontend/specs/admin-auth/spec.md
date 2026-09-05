## MODIFIED Requirements

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
