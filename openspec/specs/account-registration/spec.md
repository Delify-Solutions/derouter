# account-registration Specification

## Purpose
Protects the public signup and account-recovery endpoints from abuse, keeps one password policy across every way a password is set, warns the operator when verification mail cannot be delivered, and returns a visitor to the page they were heading to after signing up or in.
## Requirements
### Requirement: Public account endpoints are rate limited
The system SHALL limit, counting attempts in a rolling one-hour window held in process memory:
- `POST /api/public/register`: at most 5 attempts per client IP;
- `POST /api/public/resend-verification`: at most 3 attempts per normalized email and 10 per client IP;
- `POST /api/public/forgot-password`: at most 3 attempts per normalized email and 10 per client IP.

An attempt over a limit SHALL be answered with HTTP 429, a `Retry-After` header in seconds and a Vietnamese error message, without creating an account or sending mail. The per-email limit SHALL apply whether or not the email belongs to an account, and responses SHALL NOT reveal whether it does. Counters reset when the process restarts.

#### Scenario: Sixth registration from one IP
- **WHEN** one IP has submitted 5 registrations in the last hour and submits a sixth
- **THEN** the response is HTTP 429 with `Retry-After` and no user row is created

#### Scenario: Reset mail flood for one address
- **WHEN** 3 forgot-password requests for `a@b.com` were made in the last hour and a fourth arrives from a different IP
- **THEN** the response is HTTP 429 and no mail is sent

### Requirement: One password policy
Every path that sets a password — public signup, password reset by token, admin account creation and admin password reset — SHALL require between 10 and 200 characters and SHALL reject anything else with HTTP 400 and a Vietnamese message stating the rule.

#### Scenario: Admin sets a short password
- **WHEN** an admin resets a user's password to a 9-character value
- **THEN** the response is HTTP 400 and the stored password hash is unchanged

### Requirement: Mail relay warning
When the setting `requireEmailVerification` is on and `smtpRelayUrl` is empty, the admin settings page (signup section) and the admin users page SHALL show the warning "Đang bật xác minh email nhưng chưa cấu hình mail relay — khách mới sẽ không nhận được mail xác minh. Cấu hình relay hoặc tắt xác minh email." The warning SHALL disappear once either condition stops holding.

#### Scenario: Warning visible
- **WHEN** verification is required and no relay URL is set
- **THEN** both admin pages display the warning text

### Requirement: Safe post-authentication redirect
`/login` and `/register` SHALL accept a `next` query parameter. A `next` value is valid only if it is a relative path starting with `/account` that contains no scheme, no `//` and no backslash. After a successful login the browser SHALL go to a valid `next`, otherwise to `/account`. When registration requires email verification, the verification link in the mail SHALL carry the valid `next`, and the verify-email page SHALL forward it to the login link it shows.

#### Scenario: Next honored
- **WHEN** a visitor logs in from `/login?next=/account/plans?plan=go`
- **THEN** the browser lands on `/account/plans?plan=go`

#### Scenario: Open redirect refused
- **WHEN** a visitor logs in from `/login?next=//evil.example`
- **THEN** the browser lands on `/account`

### Requirement: Registration records the referrer
When the affiliate program is enabled, `POST /api/public/register` SHALL bind the new account to the referrer of the first VALID code among, in order, the `ref` field of the request body and the `dr_ref` cookie. A code SHALL be valid only when it belongs to an existing, non-blocked affiliate; an invalid `ref` SHALL fall through to a valid cookie. Otherwise the registration SHALL succeed without a referrer, and the response SHALL NOT reveal whether a code was valid. The binding SHALL be written in the same write as the account (`referredByUserId`, `referredAt`). After a successful registration the `dr_ref` cookie SHALL be cleared. A code SHALL never bind an account that already exists.

#### Scenario: Signup through a referral link
- **WHEN** a visitor holding cookie `dr_ref=K7Q2MZ` (an active affiliate's code) registers
- **THEN** the new account's referrer is that affiliate and the `dr_ref` cookie is cleared

#### Scenario: Body ref wins over cookie
- **WHEN** the body carries `ref=AAAAAA` (valid) and the cookie carries `BBBBBB` (valid)
- **THEN** the account is bound to the owner of `AAAAAA`

#### Scenario: Invalid ref falls through to a valid cookie
- **WHEN** the body carries `ref=NOPE22` (unknown) and the cookie carries `BBBBBB` (valid)
- **THEN** the account is bound to the owner of `BBBBBB`

#### Scenario: Invalid or blocked code
- **WHEN** the code is unknown, belongs to a blocked affiliate, or the program is disabled
- **THEN** the account is created with no referrer and the response is identical to a signup without a code

### Requirement: Register page shows the referral welcome gift
`/register` SHALL show a referral banner for the first valid code among, in order, the `ref` query parameter and the `dr_ref` cookie — the same rule registration uses, so the banner always names the referrer the account will be bound to. The banner SHALL NOT show the referrer's email. When that referral has an eligible welcome gift code (see affiliate-program "Referral welcome gift"), the banner SHALL show the code and say that it needs a Telegram link and is entered on the "Mã quà tặng" page after signup. The register form SHALL send the code it displayed as `ref`.

#### Scenario: Banner with gift
- **WHEN** a visitor opens `/register?ref=K7Q2MZ` and the affiliate's effective gift code is the active new-user code `WELC-OME1`
- **THEN** the page shows "Bạn được giới thiệu" and the code `WELC-OME1` with the Telegram note

#### Scenario: No eligible gift
- **WHEN** the effective gift code is inactive, expired or exhausted
- **THEN** the banner shows without any gift code

