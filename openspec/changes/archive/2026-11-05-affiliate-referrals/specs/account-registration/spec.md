## ADDED Requirements

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
