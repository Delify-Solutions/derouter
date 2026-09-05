## ADDED Requirements

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
