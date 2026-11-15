## Context

`telegram-notify` made the bot an *outbound* channel: it writes to customers and to the admin. This change makes it bidirectional with the smallest possible surface.

Two constraints decide the design:

1. **Telegram allows exactly one reader of a bot's updates.** `getUpdates` and a webhook are mutually exclusive, and two pollers fight: the loser gets `409 Conflict`. This deployment has no webhook, so the poller owns the stream — but that has to be explicit, because a future webhook would silently break the chat.
2. **The customer's chat is the conversation.** There is no customer-facing web chat to build: their side is the bot chat, which Telegram authenticates with the update itself. The only missing piece is routing.

## Goals / Non-Goals

**Goals**
- A customer types in the bot; the admin gets it and can answer from a phone.
- No new admin workflow invented: Telegram's Reply is the answer mechanism.
- A dashboard view for the operator at a computer, with unread counts.
- No duplicate deliveries, no replayed messages after a restart.

**Non-Goals**
- Attachments in either direction.
- Several admin recipients, or an admin-chat group with per-admin assignment.
- Canned replies, SLAs, or support hours.
- A web chat that does not go through Telegram.

## Decisions

### D1 — `supportMessages` is the thread; no thread table
A conversation is every row of one `userId`. A separate `supportThreads` table would only duplicate `MAX(createdAt)` and the unread count, which a grouped query answers without a second write on every message.

Ordering is by `rowid`, not by `createdAt` or `id`: `id` is a random uuid (unordered) and two messages can share a millisecond. `rowid` is the insertion order, which is exactly what a conversation means.

### D2 — Inbound storage is idempotent on (userId, telegramMessageId)
Telegram re-sends an update whose offset was not confirmed. A unique index makes the second delivery a no-op rather than a duplicate message and a second relay.

### D3 — The offset is persisted BEFORE the batch is handled
At-most-once, not at-least-once. A crash mid-batch loses at most the messages in flight; the alternative (offset after handling) replays a whole batch after every crash, which for a support chat means telling the admin the same thing three times. The trade is stated in the spec.

### D4 — Relay identity lives in `kv`, keyed by the admin-chat message id
The admin answers by replying to a specific message, so the bot must map that message id back to an account. A dedicated column would mean a second table for one integer; `kv` with scope `telegramSupportRelay` is the existing mechanism for exactly this kind of mapping and survives restarts.

### D5 — Only delivered messages join the conversation
Storing before sending would show the admin their answer in the thread even when Telegram refused it — and the admin would believe the customer had read it. So: send, then store, and report the failure to the sender. A `blocked` answer marks the account exactly like any other refused delivery.

### D6 — Plain messages only
`allowed_updates: ["message"]` and a `chat.type === "private"` check keep the surface narrow. No callbacks, no channel posts, no group messages: every one of those needs its own authorisation story, and none of them carries "I need help with my plan".

Non-text messages are ignored rather than downloaded, which keeps file handling (and its attack surface) out of the feature entirely.

### D7 — Back off by reason, not by failure
`not_configured` means the operator has not set a token: poll every 30 seconds, not every second. `conflict` means someone else owns the stream: wait minutes. A transient network error: five seconds. A single failure rate would either hammer Telegram or make the chat feel dead.

### D8 — The relay carries a masked email
The admin needs to recognise the account; the chat is a third-party service. `a***@domain` plus the display name and @username is enough to act on and not enough to harvest.

## Risks / Trade-offs

- **A webhook deployment breaks the chat.** Telegram will answer `409` and the loop backs off; the admin sees no messages and has to disable one of the two. Documented in the proposal's operations note.
- **One bot for both directions means load coupling.** A long poll holds a connection open for 25 seconds; if Telegram is slow, only the support loop is affected — notifications use their own calls.
- **At-most-once can drop a message in a crash window.** Accepted: a support message that arrives twice is worse than one that is lost and re-sent by the customer.
- **`kv` grows one row per relay.** Bounded by conversation activity and pruned only with the table; acceptable at this scale.
- **No attachments** means an error screenshot cannot be sent. The docs say so and ask for the text form.

## Migration

Additive only:

- `supportMessages` is created by the existing auto-sync (`CREATE TABLE IF NOT EXISTS` through `TABLES`).
- The `kv` scope needs no schema change.
- `SCHEMA_VERSION` 32 → 33 so `migrate.js` takes its pre-change backup.

No existing row is read differently, and with no messages the feature costs one idle long poll per process.
