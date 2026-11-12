## 1. Plumbing

- [x] 1.1 `botApi.js` (callBotApi, botClient: send / edit / answer)
- [x] 1.2 Webhook route: secret header, dedupe, per-user rate limit ← (verify: 401 without the secret; secret not readable or writable through /api/settings)
- [x] 1.3 Admin route `/api/telegram-bot`: status, enable (setWebhook + setMyCommands), disable; settings `telegramAdminIds` validation

## 2. Commands

- [x] 2.1 Shared `redeemForAccount`; web redeem route switched to it
- [x] 2.2 Customer: /start /help /id /me /usage /gifts /gift /plans /keys /settings /unlink, buttons
- [x] 2.3 Admin: /stats /orders (confirm, approve, cancel) /user ← (verify: only listed ids; two taps; approvedBy and audit)

## 3. UI and checks

- [x] 3.1 Admin card "Lệnh bot" on /dashboard/telegram
- [x] 3.2 `test/telegram-bot.test.js`; npm test, lint, build; live webhook check
