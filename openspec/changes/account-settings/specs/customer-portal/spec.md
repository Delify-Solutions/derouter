## MODIFIED Requirements

### Requirement: Navigation and language
The account navigation SHALL be, in order: `Tổng quan` (/account), `Chat` (/account/chat), `Gói của tôi` (/account/plans), `Nhật ký credit` (/account/ledger), `Mã quà tặng` (/account/gift), `Giới thiệu` (/account/affiliate, only when the affiliate program makes it available), `API key` (/account/keys), `Lịch sử dùng` (/account/usage), `Tài khoản` (/account/settings). Every account page SHALL be in Vietnamese.

On screens narrower than the `lg` breakpoint the navigation SHALL be a hamburger button in the header that opens a menu panel listing every destination and sign-out. The panel SHALL be a modal dialog with a translucent, blurred ("liquid glass") surface, rounded corners, a specular highlight and a soft shadow, as a documented exception to `openspec/ui-dna.md` limited to this panel. It SHALL close on choosing an item, Escape, a tap outside and a route change; move focus into the panel when opened and back to the button when closed; keep keyboard focus inside and the page behind it inert while open; mark the current page with more than colour; drop its animation under reduced motion; and fall back to an opaque surface under reduced transparency. Text in the panel SHALL meet WCAG AA in both themes.

#### Scenario: No English labels
- **WHEN** a customer visits each account page
- **THEN** headings, buttons, labels, empty states and errors are Vietnamese

#### Scenario: Phone navigation
- **WHEN** a customer on a 390px-wide screen taps the menu button and then "API key"
- **THEN** the glass panel lists every destination, the API key page opens, and the panel is closed

#### Scenario: Escape closes the menu
- **WHEN** the menu panel is open and the customer presses Escape
- **THEN** the panel closes and focus returns to the menu button

## ADDED Requirements

### Requirement: Account settings page
`/account/settings` ("Tài khoản") SHALL have two tabs. "Bảo mật" SHALL show the email, the account creation date, the last sign-in and whether Telegram is linked, plus the email change and password change forms. "Lịch sử" SHALL show the account history. The header avatar SHALL link to this page.

#### Scenario: Open from the avatar
- **WHEN** a customer clicks the avatar in the header
- **THEN** `/account/settings` opens on the "Bảo mật" tab

### Requirement: Change email by confirmation link
A customer SHALL request an email change with the new address, typed twice, and the current password. The request SHALL be refused when the password is wrong, the address is malformed, equal to the current one or used by another account, or after 5 requests in an hour. On success a single-use link valid for 24 hours SHALL be mailed to the new address, any earlier pending link SHALL stop working, and the old address and the linked Telegram SHALL be told. When mail cannot be sent the request SHALL fail with a message saying so and leave no pending change.

Opening the link SHALL show a confirmation button and pressing it SHALL change the email (opening alone SHALL NOT), unless the address was taken in the meantime; then the change SHALL be refused with a message and the account keeps its current email. An `unverified` account SHALL become `active`; a suspended account SHALL stay suspended. The old address and the linked Telegram SHALL be told that the change happened. Existing sessions SHALL stay signed in. The settings page SHALL show a pending change with "Gửi lại" and "Hủy".

Confirming SHALL also invalidate every other outstanding link of the account (password reset, verification). Both steps SHALL be written to the activity log with the addresses masked.

#### Scenario: Email changes only after the link
- **WHEN** a customer requests a change to new@example.com with the right password
- **THEN** the account email is unchanged until the link mailed to new@example.com is opened, and then it is new@example.com

#### Scenario: Wrong password
- **WHEN** the current password is wrong
- **THEN** the request is refused and no link is sent

#### Scenario: Address taken before confirming
- **WHEN** another account registers new@example.com after the request and the customer then opens the link
- **THEN** the email is not changed and the page says the address is already in use

#### Scenario: Mail not configured
- **WHEN** no mail relay is configured
- **THEN** the request fails with a message that email cannot be sent and no pending change is shown

### Requirement: Change password from the settings page
The "Bảo mật" tab SHALL change the password with the current password, the new password and its confirmation, using `POST /api/account/password`. The new password SHALL follow the registration password policy. Other sessions SHALL be signed out and the linked Telegram told, as today. Errors SHALL be Vietnamese, and more than 10 attempts in an hour SHALL be refused until the hour passes.

#### Scenario: Password changed
- **WHEN** a customer submits the right current password and a valid new one twice
- **THEN** the password changes, this session stays signed in, and other sessions are signed out

### Requirement: Account history
`GET /api/account/history` SHALL return, for the caller only, a timeline newest first, filterable by group (`all`, `security`, `orders`, `plans`) and paged by offset:
- security events from the activity log: sign-in, sign-out, failed sign-in, password change and reset, email change requested and confirmed, email verified, Telegram link and unlink, API key created and deleted, with time, IP and device;
- orders: plan, amount and currency, status and payment time;
- plans, credit and gifts: each grant with its source (purchase, gift code with the code, admin, affiliate credit, referral bonus), plan name, credit or unlimited, and expiry, and an entry when a plan expired.

The first page SHALL also return a summary: account creation, last sign-in, paid orders and the total paid per currency, credit spent and requests charged. The "Lịch sử" tab SHALL show the summary, filter chips and "Xem thêm".

#### Scenario: Mixed timeline
- **WHEN** a customer signed in, bought a plan, then redeemed a gift code
- **THEN** "Tất cả" lists the gift, the plan grant, the order and the sign-in, newest first

#### Scenario: Another customer's data
- **WHEN** any customer calls the history API
- **THEN** only rows of that customer's own account are returned
