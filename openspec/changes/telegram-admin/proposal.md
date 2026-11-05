## Why

Customers link their account to Telegram themselves, and only they can unlink it. The admin has no view of which accounts are linked and no way to remove a wrong link (a Telegram account linked by mistake, one that belongs to someone else, a shared account). The owner asked for Telegram link management in the admin, with unlinking.

The same change narrows who sees the new-user promo popup: the owner saw it on old accounts, because "new" only meant "never bought a plan", and the docs pages showed it to every signed-in customer.

## What Changes

- **User detail → Tổng quan → Telegram panel**: the linked Telegram user (@username, id, link time) and "Gỡ liên kết" with a mandatory reason.
- **`/dashboard/telegram` → "Tài khoản đã liên kết"**: every linked account, searchable by email, @username or Telegram id, with the bot-blocked state and "Gỡ liên kết".
- **Unlink by admin**: tells the Telegram user first (best effort), clears the link, audits `telegram_unlinked` on the account and writes `telegram_unlink` (by admin) to the customer's activity, so their history shows it. Gift redemptions keep their Telegram snapshot, so a new-user gift cannot be claimed again by relinking.
- **Promo popup audience** (owner decision): an account is "new" only if it never received any plan or credit (any source) and never redeemed a gift code. Signed-in customers on the public pages (landing, docs, register) follow the same rule. The `promo-popup` change's spec delta is updated accordingly.

## Capabilities

### New Capabilities
- (none)

### Modified Capabilities
- `admin-user-management`: Telegram link management.

## Impact

- `src/lib/db/repos/telegramLinkRepo.js` (`listTelegramLinksSync`, `adminUnlinkTelegramSync`), `src/lib/notify/customerTelegram.js` (message), routes `GET /api/telegram-links`, `DELETE /api/users/[id]/telegram`; `TelegramPanel.js`, `OverviewTab.js`, `AuditTab.js`, `/dashboard/telegram` (`TelegramLinksClient.js`), customer `HistoryTab.js` (label).
- `src/lib/promo/newAccount.js`, `PromoPopupSlot.js`; `openspec/changes/promo-popup/specs/promo-popup/spec.md`.
- No schema change. Tests: `test/telegram-admin.test.js`, `test/promo-popup-audience.test.js`.
