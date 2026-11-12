## 1. Discount reasons
- [x] 1.1 `reasons` from `getActiveDiscountsForModels`; catalog, receipts, account usage history; admin label wording
- [x] 1.2 Show the reasons on landing pricing, usage page and account usage ← (verify: every "Giảm X%" surface shows the reason when a rule has one)

## 2. Model pages
- [x] 2.1 `buildModelPriceList`; receipts route uses it
- [x] 2.2 `/models` public page, landing nav link; `/account/models` + nav item ← (verify: account page lists only the group's allowed models with the customer's own discounts)

## 3. Notifications
- [x] 3.1 Schema + repos: announcements, customerNotifications, notificationsSeenAt; SCHEMA_VERSION 33
- [x] 3.2 `notifyCustomer` stores personal notifications
- [x] 3.3 Admin `/dashboard/announcements` with optional Telegram broadcast
- [x] 3.4 `/account/notifications` with tabs, unread badge, Telegram section ← (verify: a customer without Telegram sees billing/expiry/security notices; unread count resets on open)

## 4. Telegram channel
- [x] 4.1 `telegramChannelUrl` setting (validated) on `/dashboard/telegram`; landing nav/footer, account menu, notifications page

## 5. Checks
- [x] 5.1 Tests, `npm test`, lint, build, live check
