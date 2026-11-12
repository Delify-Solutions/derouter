## ADDED Requirements

### Requirement: Signup without verification signs in
When public signup creates an account whose status is `active` (email verification is off), `POST /api/public/register` SHALL sign the visitor in exactly as a successful login does — set the `user_token` cookie, persist a session row and stamp `lastLoginAt` — and SHALL return `signedIn: true`. When the account is `unverified`, the response SHALL return `signedIn: false`, the verification mail SHALL be sent and no session SHALL be created. The response SHALL NOT include the user id or status.

#### Scenario: Verification off
- **WHEN** `requireEmailVerification` is off and a visitor registers a new address
- **THEN** the response has `signedIn: true`, a `user_token` cookie is set and a session row exists for the new user

#### Scenario: Verification on
- **WHEN** `requireEmailVerification` is on and a visitor registers a new address
- **THEN** the response has `signedIn: false`, no `user_token` cookie is set and the verification mail is sent

## MODIFIED Requirements

### Requirement: Safe post-authentication redirect
`/login` and `/register` SHALL accept a `next` query parameter. A `next` value is valid only if it is a relative path starting with `/account` that contains no scheme, no `//` and no backslash. After a successful login, or a signup that signed the visitor in, the browser SHALL go to a valid `next`, otherwise to `/account`. When registration requires email verification, the verification link in the mail SHALL carry the valid `next`, and the verify-email page SHALL forward it to the login link it shows.

#### Scenario: Next honored
- **WHEN** a visitor logs in from `/login?next=/account/plans?plan=go`
- **THEN** the browser lands on `/account/plans?plan=go`

#### Scenario: Open redirect refused
- **WHEN** a visitor logs in from `/login?next=//evil.example`
- **THEN** the browser lands on `/account`

#### Scenario: Signup without verification
- **WHEN** email verification is off and a visitor registers from `/register?next=/account/plans?plan=go`
- **THEN** the browser lands on `/account/plans?plan=go` already signed in, without an inbox screen
