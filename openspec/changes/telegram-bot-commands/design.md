## Context

The bot token lives in settings; customers link their Telegram user to their
account (unique `users.telegramUserId`). Notifications already go out through
`sendMessage`.

## Decisions

### D1. Webhook with a secret token
`setWebhook` registers `/api/public/telegram/webhook` with a random 64-hex
`secret_token`; every update must carry it in `X-Telegram-Bot-Api-Secret-Token`
(constant-time compare, 401 otherwise). Enabling again rotates the secret. The
secret is never returned by `GET /api/settings` and cannot be set through
`PATCH /api/settings`. Accepted updates always answer 200 (no retry storms);
duplicate `update_id`s are skipped in memory; 30 updates a minute per Telegram
user.

### D2. Identity is Telegram's `from.id`
The customer is the account whose `telegramUserId` equals `from.id`; nothing typed
in the chat selects an account. Admins are the ids in `telegramAdminIds`; admin
commands answer "unknown" to anyone else. Private chats only.

### D3. One redemption flow
`redeemForAccount` (channel membership check before the transaction, re-bound
inside it; welcome → channel offer) is used by the web route and the bot, so both
apply the same rules. Bot redemptions are logged with `via: "telegram_bot"`.

### D4. Two taps for order actions
`/orders` lists up to 8 pending orders; "Duyệt"/"Huỷ" first shows the order and a
confirmation button. Approval uses `approveOrder` (idempotent) with
`approvedBy = telegram:<id> (@username)` and notifies the customer; cancellation
is guarded by `fromStatus: "pending"` and audited as `order_cancelled`.

### D5. Replies
Telegram HTML, Vietnamese. Button presses edit the message they were on, except a
redemption, which adds a message. URL buttons only for an https base URL
(`publicBaseUrl`, else the one saved when enabling). API keys are shown by prefix
only.

### D6. Enable and disable leave a consistent state
Enable calls `setWebhook` first and saves the new secret and base URL only when
Telegram accepted it, so a refused update keeps the working bot. Disable deletes
the webhook, clears the secret (a leaked one stops working) and removes the
command menus; admins dropped from the list lose their chat-scoped menu on the
next enable (`telegramBotAdminMenuIds` remembers who got one).

### D7. Model names in /usage
Top models are named by the combo the customer called
(`usageHistory.meta.requestedModel`), never the upstream model (spec
model-privacy).

## Risks / Trade-offs

- Duplicate suppression and rate limits are per process (in memory).
- A chat-scoped admin menu needs the admin to have opened the bot once; the
  enable result names those that failed.
