## Why

Customers have no way to talk to the owner. The bot already reaches them for notifications, and the owner already receives alerts in a private admin chat, but that pipe is one-way: a customer who needs help has nowhere to type, and the owner has no inbox.

The owner asked for exactly this: `/help` in the bot opens a chat with the admin; the admin receives the message and answers; the customer sees the answer in the same bot chat.

## What Changes

- **A customer's message in the bot is relayed to the admin chat.** Any free text from a linked account is stored and forwarded with enough context to act on: display name, masked email, Telegram username and the message. The customer gets a one-line confirmation so they know it left their phone.
- **The admin answers with Telegram's own Reply.** A reply in the admin chat to a relayed message is delivered back to that customer's chat and stored. No admin UI is needed to answer; the owner can do it from a phone.
- **A dashboard inbox is the second way to answer.** `/dashboard/telegram` gains a support panel: one row per conversation with an unread count, the full thread, and a reply box that delivers through the same path as the Telegram reply.
- **`/help` (and `/start`) opens the conversation.** Commands are answered with instructions and are not relayed. The account page links `https://t.me/<bot>?start=help`, so the first thing the customer sees is how to use the chat.
- **An unlinked chat is told how to link,** and nothing is forwarded. A suspended account is answered instead of ignored.
- **The bot has exactly one reader of updates.** A long-polling loop is started by `initializeApp`, stores the update offset in `_meta` so a restart cannot replay a message, and backs off on `not_configured` and on `conflict` (a webhook or another instance owns the stream). `DISABLE_TELEGRAM_SUPPORT=true` turns it off.
- **Only delivered messages are stored.** An answer Telegram refuses is reported to the admin and is not added to the conversation, so the thread never shows something the customer did not receive.

## Capabilities

### Added Capabilities
- `telegram-support`: two-way support chat over the bot.

### Modified Capabilities
- `telegram-notify`: the bot's update stream is read by the support loop; a relayed reply clears the "refused delivery" marker like any other delivered message.
- `customer-portal`: the Telegram card on `/account` links the support chat.

## Impact

- **Code**: `src/lib/notify/supportChat.js` (new), `src/lib/notify/telegramApi.js` (`getUpdates`, `sendChatAction`, `messageId`), `src/app/api/support/messages/route.js` (new), `src/app/(dashboard)/dashboard/telegram/SupportInbox.js` (new) and its page, `src/app/account/components/TelegramLink.js`, `src/shared/services/initializeApp.js`.
- **Database**: `supportMessages` (new table) and one `kv` scope (`telegramSupportRelay`) mapping an admin-chat message id to an account; `SCHEMA_VERSION` 32 → 33. Additive only.
- **Operations**: the bot may have only one reader of updates. A deployment that sets a webhook on the same bot MUST NOT start the support loop (Telegram answers 409, and the loop backs off rather than hammering).
- **Privacy**: the relay carries a masked email, never the full address and never a message body in a log.
- **Out of scope**: attachments (photos, files, stickers) in either direction, multiple admin recipients, canned replies, support hours, and a customer-facing web chat that does not go through Telegram.
