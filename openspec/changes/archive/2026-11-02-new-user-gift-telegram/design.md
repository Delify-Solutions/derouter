## Context

Gift codes (`giftRepo.redeemGiftCode`) already enforce the active flag, validity window, total and per-account limits inside one synchronous transaction. The Telegram bot is configured for admin notifications only (`telegramBotToken`, `telegramChatId`); nothing receives updates from Telegram.

## Decisions

### D1. Mini App instead of a `/start` deep link
A `t.me/<bot>?start=<token>` link shows a Start button to anyone who has not chatted with the bot. The bot learns the token only after that tap, and only through a webhook or polling. A Mini App direct link (`t.me/<bot>/<app>?startapp=<token>`) opens our page inside Telegram. Telegram gives the page `initData`: the user, `auth_date` and `start_param` (our token), signed with HMAC-SHA256 under the key `HMAC_SHA256("WebAppData", botToken)`. The page posts it to our server, so linking needs one tap, no webhook and no message in a chat. The first launch of a Mini App may show Telegram's own confirmation, which we cannot remove.

### D2. Link tokens
- `POST /api/account/telegram/link` issues 32 random bytes (base64url, within the `startapp` alphabet). It stores only the SHA-256 and invalidates the account's earlier unused tokens.
- Tokens live 10 minutes and are single-use.
- `POST /api/public/telegram/link { initData }` performs these checks, in order:
  1. the signature;
  2. `auth_date` no older than 1 hour;
  3. the token is known, unused and unexpired;
  4. the Telegram user is not linked to another account.

  It then links and marks the token used, in one transaction.
- The endpoint is public (the page runs inside Telegram without our cookie). The signed token is what binds it to an account. It is rate limited per IP.

### D3. Who is a "new user"
For a typed redemption of a `newUserOnly` code, the checks run in this order, so that only a refusal which linking can fix offers the link button:
1. the account has no `userPlans` row with `source = 'purchase'` and no earlier redemption of any `newUserOnly` code → else `not_new_user`. The same code typed twice still reports `already_redeemed`, which is checked first.
2. `users.telegramUserId` is set → else `telegram_required`.
3. no redemption of a `newUserOnly` code carries this `telegramUserId` → else `telegram_used`.

All three run inside the redemption transaction, after the per-account limit, so two accounts racing with the same Telegram cannot both pass. The redemption row stores `telegramUserId`. That snapshot, not the current link, is what blocks a second claim, so unlinking does not reset it.

### D4. Admin assignment bypasses the new-user conditions
`assignedBy` set → none of D3 applies (owner's decision). The Telegram id is still stored when the account has one, so an assigned welcome gift also uses up that Telegram's one claim.

### D5. One redemption per account
`newUserOnly` forces `perUserLimit = 1` on create and update.

### D6. Headers for `/telegram/link`
The global headers send `X-Frame-Options: DENY` and `frame-ancestors 'none'`, which break Telegram Web, because it shows Mini Apps in an iframe. The global rule now excludes `/telegram/link`. That path gets its own CSP:
- `frame-ancestors https://web.telegram.org`;
- `script-src` adds `https://telegram.org` for the official `telegram-web-app.js`.

Native Telegram apps use a webview and are unaffected.

### D7. Unique Telegram per account
A partial unique index `users(telegramUserId) WHERE telegramUserId IS NOT NULL` enforces it. Linking a Telegram that belongs to another account is refused with "Tài khoản Telegram này đang liên kết với tài khoản khác". Unlinking clears the three columns.

## Risks

- Virtual numbers and bought Telegram accounts still work. The cost per claim is far above the value of a welcome gift.
- Customers without Telegram cannot take the welcome gift. Everything else is unaffected.
- The bot token is the signing key. It already sits in settings, and it is never logged or returned by these endpoints.
