## Context

The customer area (`src/app/account/**`) is a sidebar shell (`AccountShell.js`) with one page per concern. Sessions are a JWT cookie plus a `userSessions` row; `resolveAccountUser` reads the email from the users row, so changing `users.email` does not invalidate a session. Single-use tokens live in `emailVerifications` (`createVerification`, `consumeVerification`), used today for email verification and password reset. Mail goes through an HTTP relay; `sendMail` returns `{ ok:false, reason:"smtp_not_configured" }` when none is configured.

## Goals / Non-Goals

**Goals:** self-service email and password change, one history view, a usable phone navigation.

**Non-Goals:** changing the display name, deleting one's own account, 2FA, exporting history, changing the admin dashboard or landing navigation.

## Decisions

### D1. Email change token carries the new address
`emailVerifications` gains `newEmail`. Purpose `change_email`. A request replaces any outstanding `change_email` token of the account, so only the latest link works. The token is mailed to the new address; the raw token is never stored or logged.

Confirming runs in one transaction (and drops every other unconsumed token of the account, so a reset link sitting in the old mailbox cannot take the account back): the row must be unconsumed, unexpired and of purpose `change_email`; the new address must still be free (another account may have taken it since the request: answered with a clear error, the account keeps its email, the token stays unconsumed and simply expires); then `users.email` is updated, the token consumed, and an `unverified` account becomes `active` (opening the link proves the address, the same rule as `verify-email`; a suspended account is never touched).

The confirm endpoint is `POST /api/public/confirm-email { token }`, called by the `/confirm-email` page only when the person presses "Xác nhận đổi email": neither a scanner's GET of the link nor a sandbox that runs page script uses the token. The new address is typed twice in the request form, so a typo does not send the link to a stranger.

Request checks, in order: session; current password (bcrypt); address shape (`isValidEmailShape`); not the current address; not used by another account; rate limits (5 per hour per account, wrong passwords counted in the same bucket). The response never reveals more than "already in use" for a taken address, which the signup form reveals anyway.

When the relay is not configured or fails, the token is deleted and the request answers 503 "Hệ thống chưa gửi được email…". A link that cannot arrive must not sit pending.

Notifications: on request, a security Telegram message and a mail to the OLD address ("a change to X was requested; ignore if it was you, otherwise change your password"); on completion, Telegram plus a mail to the old address. Activity rows: `email_change_requested` (details: masked new address) and `email_changed` (masked old and new).

Sessions are kept: the person who proved both the password and the new mailbox is the owner. A password change already revokes other sessions; that is unchanged.

### D2. History is read from existing tables, merged in the server
No new event table. `GET /api/account/history?group=all|security|orders|plans&offset&limit` reads:
- `activityLog` rows of the caller whose action is in a fixed security list;
- `orders` of the caller (one entry per order, at its creation, with its current status, plan name, amount, currency and `paidAt`);
- `userPlans` of the caller: a grant entry at `createdAt` (source, plan name, credit or unlimited, expiry, gift code via `giftRedemptions`) and an expiry entry at `expiresAt` once that is in the past.

Each source is read newest-first with `LIMIT offset+limit+1`, the lists are merged by time in JS and sliced. Offset is capped at 2000; per-account volumes are small and every query uses an existing `userId` index. Entries carry structured fields; the page writes the Vietnamese sentences.

The summary is computed on the first page only: account created, last sign-in, paid orders and the sum of `payAmount` per `payCurrency` over `status='paid'`, credit spent (sum of `-deltaNanoUsd` over `creditLedger` rows of kind `charge`), and requests charged (count of those rows; unlimited plans are ledgered too, so the count is complete).

Only the caller's rows are ever read; the user id comes from the session, never from the query.

### D3. Password change
The existing route keeps its logic. Messages become Vietnamese; attempts are rate-limited (10 per hour per account), counted before the password is checked so parallel requests cannot slip past, so a stolen session cannot brute-force the password.

### D4. Liquid-glass mobile menu
Below `lg` the header gets a 32px square hamburger (`aria-expanded`, `aria-haspopup="dialog"`). It opens a modal dialog rendered into `<body>` at z-50, over the header too:
- `.liquid-glass` in globals.css: `backdrop-filter: blur(28px) saturate(180%)`, a translucent fill (white 0.78 light, zinc-900 0.72 dark), a 1px light border, a specular top highlight (`::before` gradient and inset highlight), a soft drop shadow, 22px radius, 12px inset from the screen edges; a lightly blurred dim behind it;
- labels are zinc-800 / zinc-200 so contrast stays AA over any page content; the active item has a filled pill and a check mark (not colour alone); sign-out at the bottom;
- a 180ms fade and scale on open; `prefers-reduced-motion` removes it and `prefers-reduced-transparency` / `prefers-contrast: more` fall back to an opaque surface;
- Escape, a tap anywhere outside, the close button, choosing an item and a route change close it; focus moves into the panel on open and back to the button on every close; Tab is trapped and the account shell is `inert` while open.

The exception to the UI DNA (blur, translucency, rounded corners, the highlight and the soft shadow that make the material read as glass) is stated in a comment in the component and in globals.css; nothing else in the system uses them.

## Risks / Trade-offs

- **Relay down at the wrong moment** → request refused, customer retries later; nothing pending.
- **Two accounts race for the same new address** → `users.email` is UNIQUE; the confirm transaction checks first and maps a constraint failure to the same message.
- **Backdrop blur cost on low-end phones** → one small panel, only while open.
- **Schema version ordering with open PRs** → this branch uses 32; merging after #47 (30) and #46 (31) keeps versions increasing.
