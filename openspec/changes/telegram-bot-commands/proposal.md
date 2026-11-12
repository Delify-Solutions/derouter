## Why

The Telegram bot only sends messages (notifications, the link confirmation). The
owner wants customers and admins to do more from the bot with quick commands.

## What Changes

- The bot receives updates through a webhook (`POST /api/public/telegram/webhook`)
  authenticated by Telegram's secret-token header; private chats only.
- Customer commands for the linked account: `/me` (credit, plans, expiry, debt),
  `/usage` (today and 7 days, top models), `/gifts` (listed codes with take
  buttons) and `/gift CODE` (same redemption flow as the web, channel check
  included, welcome → channel offer), `/plans` (catalogue with a buy link),
  `/keys` (masked), `/settings` (notification groups, unlink), `/help`, `/id`.
- Admin commands for Telegram ids listed by the admin: `/stats` (today),
  `/orders` (pending, approve / cancel with a confirmation tap), `/user`.
- Admin page "Lệnh bot": enable / update / disable (setWebhook with a new secret,
  command menus) and the admin id list.
- The web redeem route and the bot share one redemption flow (`redeemForAccount`).

## Capabilities

### New Capabilities
- `telegram-bot`: commands over the Telegram bot.

## Impact

- New: `src/lib/telegram/botApi.js`, `src/lib/telegram/bot/{handler,customer,admin,format,config}.js`,
  `src/lib/gift/redeemFlow.js`, `src/app/api/public/telegram/webhook`, `src/app/api/telegram-bot`,
  `TelegramBotCommandsCard.js`, `test/telegram-bot.test.js`
- Changed: `src/app/api/account/redeem/route.js` (uses the shared flow), `src/app/api/settings/route.js`
  (admin ids validated, webhook secret protected and hidden), AuditTab label `order_cancelled`.
- No schema change (settings JSON keys: `telegramWebhookSecret`, `telegramBotBaseUrl`, `telegramAdminIds`).
