## 1. Data

- [x] 1.1 Schema v26: `users.telegramNotifyPrefs`, `users.telegramDmBlockedAt`, `telegramNotices`, `telegramBroadcasts`
- [x] 1.2 Link repo: status returns prefs + marker; link/unlink clear the marker; prefs setter

## 2. Delivery

- [x] 2.1 `telegramApi.js`: sendMessage with blocked / flood-limit mapping, no token in logs
- [x] 2.2 `customerTelegram.js`: `notifyCustomer` (prefs, marker, force), texts, order/plan/gift helpers, new-IP check

## 3. Hooks

- [x] 3.1 Billing: admin approve, SePay webhook, poller, resolve-assign, admin grant, gift redeem, gift assign (create + assign)
- [x] 3.2 Security: login new IP, password change/reset, key create, admin suspend/reactivate/reset, link confirmation
- [x] 3.3 Reminders job `planReminders.js`, started in `runHeavyStartup`

## 4. UI

- [x] 4.1 Mini App requests write access before linking
- [x] 4.2 `/account` Telegram card: switches, test button, blocked warning with bot link; `PATCH /api/account/telegram`, `POST /api/account/telegram/test`
- [x] 4.3 Admin `/dashboard/telegram` + `/api/telegram-broadcasts`, sidebar entry

## 5. Check

- [x] 5.1 Tests: transport mapping, prefs, marker, link clears marker, escaping, order summary, new IP, reminders (due, dedupe, retry), broadcast audience and counts
- [x] 5.2 `npm run lint`, `npm test`, `npm run build`
- [ ] 5.3 Merge deltas into `openspec/specs/` and archive
