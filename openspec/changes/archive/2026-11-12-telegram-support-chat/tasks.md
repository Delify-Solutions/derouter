## 1. Data and transport
- [x] 1.1 `src/lib/db/schema.js`: `supportMessages` (direction, body, telegramMessageId, createdBy, readAt) with indexes on `(userId, createdAt)` and unique `(userId, telegramMessageId)`; `SCHEMA_VERSION` 32 → 33.
- [x] 1.2 `telegramApi.js`: `sendTelegramMessage` returns `messageId`; new `getTelegramUpdates` (long poll, `allowed_updates: ["message"]`, offset advancing, `conflict` on 409) and `sendTelegramChatAction`; `MAX_MESSAGE_LENGTH`.

## 2. Bridge
- [x] 2.1 `src/lib/notify/supportChat.js`: `handleSupportUpdate` (customer text, commands, admin reply, unlinked, suspended, non-text, group), relay to the admin chat with a masked email, reply routing through `kv`.
- [x] 2.2 Idempotent inbound storage on `(userId, telegramMessageId)`; only delivered answers stored.
- [x] 2.3 `pollSupportUpdatesOnce` with the offset in `_meta` persisted before handling; `startSupportChat`/`stopSupportChat` with per-reason back-off and `DISABLE_TELEGRAM_SUPPORT`.
- [x] 2.4 `initializeApp` starts the loop.

## 3. Admin surface
- [x] 3.1 `GET /api/support/messages` (threads, or one conversation and mark it read) and `POST` (reply), admin-only through `dashboardGuard`.
- [x] 3.2 `SupportInbox.js` on `/dashboard/telegram`: thread list with unread counts, conversation, reply box with error reporting.

## 4. Customer surface
- [x] 4.1 `TelegramLinkCard` shows "Nhắn admin trên Telegram" → `https://t.me/<bot>?start=help`, hidden without a bot username.
- [x] 4.2 `content/docs/support.md` (how to open the chat, what the admin sees, what is not supported) added to the docs seed list.

## 4b. Fixes found by running the feature
- [x] 4b.1 The admin chat is usually a group (`-100…`): the private-only rule now applies to customers only, so an admin reply in a group is routed.
- [x] 4b.2 Inbound idempotency keyed on `(account, direction, telegram message id)`; the same id on both sides no longer collides.
- [x] 4b.3 `/help` is not stored as a conversation message.
- [x] 4b.4 A failed relay stores nothing and tells the customer it did not arrive.
- [x] 4b.5 A refused admin answer is reported to the admin chat for every reason, not only `blocked`.
- [x] 4b.6 Deleting an account deletes its conversation and relay mappings.
- [x] 4b.7 Per-customer inbound limit (20 per 10 min) so one chat cannot spend the bot's token-wide quota.
- [x] 4b.8 Non-text messages get a one-line explanation instead of silence.
- [x] 4b.9 `markRead` is explicit (`?markRead=1`), so the panel's poll cannot hide a message that arrives while the thread is open; re-clicking an open thread marks it too.

## 5. Checks
- [x] 5.1 `test/telegram-support.test.js` (34 cases): relay and storage, reply routing, unlinked/suspended, idempotency, non-text and group ignored, limits, dashboard reply, undelivered not stored, unread counts, ordering, polling offset, transport.
- [x] 5.2 `npm test`, `npm run lint`, `npm run build`.
- [x] 5.3 Merge the deltas into `openspec/specs/` and archive the change (after owner review).
