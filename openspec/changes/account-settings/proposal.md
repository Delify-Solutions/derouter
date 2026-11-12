## Why

Customers cannot manage their own account. The password API exists (`POST /api/account/password`) but no page uses it, there is no way to change the sign-in email, and the account's history is spread over several pages (orders, plans, ledger) with no security events at all. On phones the account navigation is a horizontally scrolling row of nine tabs, which hides most destinations.

The owner asked for:
- an account page where the customer changes the email and the password and sees the overall history;
- a hamburger menu on mobile, styled as Apple's "liquid glass" (frosted, translucent panel), for the customer area only.

## What Changes

- **New page `/account/settings` ("Tài khoản")**, last item of the account navigation, also reached from the avatar in the header. Two tabs:
  - **Bảo mật**: account info (email, created, last sign-in, Telegram link state), change email, change password.
  - **Lịch sử**: summary figures plus one timeline of everything that happened to the account.
- **Change email by confirmation link** (owner decision): the customer enters the new address twice and the current password. A single-use link (24 h) is mailed to the new address; the email changes only when the page it opens is confirmed with a button. Until then the page shows the pending address with "Gửi lại" and "Hủy". The old address and the linked Telegram are told when the change is requested and when it completes. With no mail relay configured the request is refused with a clear message instead of silently creating a link nobody receives.
- **Change password** UI over the existing API. The API's English errors become Vietnamese, and a rate limit is added on wrong current passwords.
- **History** (owner decision: all four groups):
  - summary: account created, last sign-in, total paid per currency, paid orders, credit spent, requests charged;
  - security events from the activity log (sign-in, sign-out, failed sign-in, password change/reset, email change requested/confirmed, email verified, Telegram link/unlink, API key created/deleted), with IP and device;
  - orders and payments (created, paid, expired, refunded, cancelled);
  - plans, credit and gifts: every grant (purchase, gift code, admin, affiliate credit, referral bonus) and every expiry.
  Filter chips: Tất cả / Bảo mật / Đơn hàng / Gói & quà; "Xem thêm" paging.
- **Mobile navigation**: below `lg`, the tab row is replaced by a hamburger button in the header that opens a liquid-glass panel (backdrop blur, translucent fill, rounded corners) listing every destination. It closes on selection, Escape, outside tap and route change, traps focus while open, and honours `prefers-reduced-motion` and `prefers-reduced-transparency`. This is a deliberate, documented exception to `openspec/ui-dna.md` (square, no blur), limited to this one component.

## Capabilities

### New Capabilities
- (none)

### Modified Capabilities
- `customer-portal`: navigation (new item, hamburger on mobile), new account settings page, email change, password change UI, account history.

## Impact

- Schema: `emailVerifications.newEmail` (TEXT, nullable), `SCHEMA_VERSION` 32 (30 and 31 are taken by the open PRs #47 and #46).
- Code:
  - `src/lib/users/emailChange.js` (new): request, confirm, cancel;
  - `src/lib/account/history.js` (new): summary and timeline queries;
  - `src/lib/mail/mailer.js`: two message builders;
  - `src/lib/notify/customerTelegram.js`: two security messages;
  - routes `GET/POST/DELETE /api/account/email`, `POST /api/public/confirm-email`, `GET /api/account/history`; `POST /api/account/password` messages and limit;
  - pages `/account/settings`, `/confirm-email`; `AccountShell.js` (nav item, hamburger, glass panel).
- Tests: `test/account-settings.test.js`.
