## Why

Customers can now link their Telegram account (change `new-user-gift-telegram`), but the link is only used to gate welcome gift codes. The owner wants the same link to carry account notifications, so customers hear about payments, expiring plans and security events without checking the site or their email, and so the admin can reach every customer with an announcement.

## What Changes

- Send messages from the configured bot to each linked customer for four groups:
  - **billing**: an order is approved (admin, SePay webhook, payment poller, manual match), the admin grants a plan or credit, a gift code is redeemed or assigned;
  - **expiry**: a plan ends within 3 days, then within 24 hours, unless another plan runs past it; credit across running plans drops under 10%;
  - **security**: login from an IP never used to sign in or register, password changed or reset, API key created, account suspended or reactivated, Telegram linked;
  - **announcements**: free-text messages composed by the admin.
- Customers turn billing, expiry and announcements on or off on `/account`; security messages are always sent. A "Gửi tin thử" button sends a test message.
- When Telegram refuses delivery (bot blocked, never allowed to message), the account is marked and skipped until a test message or a re-link succeeds; `/account` explains how to open the bot.
- The Mini App asks Telegram for permission to message the user before linking, and the server confirms the link in the chat.
- New admin page "Thông báo Telegram" (`/dashboard/telegram`): audience counts, compose, send in the background, history with progress.
- A periodic job (every 10 minutes) sends expiry and credit reminders once each.

## Capabilities

### New Capabilities
- `telegram-notify`: customer notifications over the linked Telegram, preferences, reminders and admin announcements.

### Modified Capabilities
- None (the link flow in `telegram-link` is unchanged; it gains a write-access request and a confirmation message, specified here).

## Impact

- Schema v26: `users.telegramNotifyPrefs`, `users.telegramDmBlockedAt`, tables `telegramNotices`, `telegramBroadcasts`.
- New: `src/lib/notify/telegramApi.js`, `customerTelegram.js`, `planReminders.js`, `broadcast.js`; `/api/account/telegram/test`; `PATCH /api/account/telegram`; `/api/telegram-broadcasts`; `/dashboard/telegram`.
- Hooks added (fire-and-forget, after commit) in order approval, payment webhook/poller/resolve, admin grants, gift redeem/assign, login, password change/reset, key create, admin user PATCH, Telegram link.
- `DISABLE_TELEGRAM_REMINDERS=true` turns the periodic job off.
