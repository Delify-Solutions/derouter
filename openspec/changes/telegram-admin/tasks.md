## 1. Telegram link management

- [x] 1.1 `listTelegramLinksSync`, `adminUnlinkTelegramSync` (audit + activity)
- [x] 1.2 `GET /api/telegram-links`, `DELETE /api/users/[id]/telegram` (reason, notify first)
- [x] 1.3 User detail Telegram panel, `/dashboard/telegram` linked-accounts list, audit label, customer history label ← (verify: unlink clears the link, keeps gift snapshots, is audited and visible to the customer; list search is literal)

## 2. Promo audience

- [x] 2.1 New-account rule: no plan of any source and no redeemed code; applied to signed-in customers on public pages too; spec delta updated ← (verify: an old account with an admin or gift plan sees no promo on /account or /docs)

## 3. Checks

- [x] 3.1 Tests; `npm test`, `npm run lint`, `npm run build`
