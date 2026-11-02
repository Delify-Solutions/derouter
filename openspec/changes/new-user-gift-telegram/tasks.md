## 1. Data

- [x] 1.1 Schema: `users.telegram*` + partial unique index, `telegramLinkTokens`, `giftCodes.newUserOnly`, `giftRedemptions.telegramUserId`; `SCHEMA_VERSION` 24
- [x] 1.2 Settings defaults `telegramBotUsername`, `telegramMiniAppName`

## 2. Telegram link

- [x] 2.1 `src/lib/telegram/initData.js`: verify Mini App init data (hash, auth_date), parse user and start_param
- [x] 2.2 `src/lib/db/repos/telegramLinkRepo.js`: issue token, consume token + link (sync, one transaction), status, unlink
- [x] 2.3 `POST/GET/DELETE /api/account/telegram[/link]`, `POST /api/public/telegram/link` (rate limited)
- [x] 2.4 Mini App page `/telegram/link` + headers in `next.config.mjs`
- [x] 2.5 Shared client hook/panel for linking with polling; Telegram section on `/account`

## 3. New-user gift codes

- [x] 3.1 `giftRepo`: `newUserOnly` on create/update/list (forces perUserLimit 1), D3 checks, store telegramUserId, admin bypass, reason texts
- [x] 3.2 `/api/account/redeem` maps the new reasons; `/api/gift-codes` accepts `newUserOnly`
- [x] 3.3 `/account/gift`: link button on `telegram_required`, auto-redeem after linking
- [x] 3.4 Admin gift page: option, tag, Telegram column in redemptions; settings: bot username + Mini App name with BotFather instructions

## 4. Check

- [x] 4.1 Tests: initData verification, link token lifecycle, new-user redemption rules
- [x] 4.2 `npm run lint`, `npm test`, `npm run build`
- [ ] 4.3 Merge deltas into `openspec/specs/` and archive
