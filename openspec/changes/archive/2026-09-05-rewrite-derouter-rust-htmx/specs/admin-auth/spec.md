## Purpose

Authenticates administrators and protects the dashboard + admin API with a cookie-based session, plus sanitization of sensitive request headers before they are stored in request details.

## ADDED Requirements

### Requirement: Admin login

The system SHALL authenticate an admin via a username + password form. Password verification SHALL use argon2 (not bcrypt). On success the server sets an `httpOnly` cookie containing a signed JWT (HMAC) identifying the admin session and redirects to `/dashboard`.

#### Scenario: Correct password

- **WHEN** an admin submits the correct username and password
- **THEN** the server sets an httpOnly JWT cookie and redirects to `/dashboard`

#### Scenario: Wrong password

- **WHEN** a visitor submits a wrong password
- **THEN** the server re-renders the login page with an error and sets no cookie

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

The system SHALL guard all `/dashboard/*` and admin API/fragment routes with a `RequireAdmin` check that rejects requests lacking a valid admin session. Unauthenticated requests to a guarded route redirect to `/login`.

#### Scenario: Guarded route without session

- **WHEN** an unauthenticated request reaches any `/dashboard/*` route
- **THEN** the server redirects to `/login` (HTML) or returns 401 (for a non-HTML/fragment request)

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
