## Context

The bot token lives in settings (`telegramBotToken`, shared with admin alerts). A linked account stores `users.telegramUserId`; for a private chat the chat id equals the user id. A bot can only message a user who started it or granted write access (Mini App `requestWriteAccess`, Bot API 6.9+).

## Decisions

### D1. One delivery function, never failing the caller
`notifyCustomer(userId, group, buildText, { force })` loads the token and the account, applies the preference and the blocked marker, sends, and records Telegram's answer. It never throws. Every hook calls it through `fireAndForget(...)` after the triggering transaction committed, so a Telegram outage cannot fail a payment, a login or a key.

### D2. Preferences
`users.telegramNotifyPrefs` is JSON `{billing, expiry, announcements}`; a missing key means on. Security is not a preference. `PATCH /api/account/telegram { notifyPrefs }` merges booleans for known keys only.

### D3. Refused delivery
A 403 or 400 "chat not found" sets `users.telegramDmBlockedAt` (matched on the current Telegram id). While set, messages are skipped except forced ones: the test button and the link confirmation. A delivered message clears it; so does a new link or an unlink. This avoids hammering Telegram for users who blocked the bot, and lets `/account` show why nothing arrives.

### D4. Write access at link time
The Mini App calls `Telegram.WebApp.requestWriteAccess()` (skipped when `allows_write_to_pm` is already true or the client is older than 6.9) before posting `initData`. The server then sends a forced "Đã liên kết" message: delivered means notifications work; refused sets the marker.

### D5. Reminders
`planReminders.js` runs every 10 minutes (60 s after start), started from `runHeavyStartup` like the billing janitor, guarded against re-entry and build phase.
- Only active accounts. Expiry: active plans with `startsAt <= now < expiresAt <= now + 3d`, skipped when another active plan of the account ends later (queued renewal) or when the plan is not longer than the window (short gifts/grants would be "expiring" on arrival). `expire_1d` when ≤ 24 h left, else `expire_3d`; recording `expire_1d` also records `expire_3d`. `refId = <planId>:<expiresAt>`, so an extension is reminded again.
- Credit: per account across running plans (`active`/`exhausted`, started, not expired); skipped when an unlimited plan is active; low when remaining (active plans) < 10% of total. `refId = <userId>:<newest plan id>`: a purchase starts a fresh allowance, an old plan expiring out of the set does not repeat the warning.
- `telegramNotices(kind, refId)` is unique. A reminder is recorded after delivery, opt-out, refusal, missing link, inactive account or a non-transient Telegram error; transient failures (network, flood limit, no token) are retried next tick.

### D6. New-IP login
Before recording a successful login, look for an earlier `login` or `register` activity row of the account with the same IP. No earlier login at all, or no trusted IP, → no message (nothing to compare with).

### D7. Announcements
`startBroadcast` validates text (1–3500 chars, sent as escaped plain text), claims the single-run slot before its first await (refusing while another runs; one process assumed), snapshots recipients (linked, active, not blocked, announcements on), writes a `telegramBroadcasts` row and sends in the background at ~20 messages/s, waiting `retry_after` up to three times on HTTP 429. Each send re-checks prefs, marker and status; opt-outs and accounts that stopped being active mid-run count as `skipped`, Telegram refusals and errors as `failed`. Progress is written every 20 messages. A row left `sending` with no runner in this process is shown as `interrupted`; nothing resumes it, so nobody receives it twice.

### D8. Texts
Vietnamese, Telegram HTML subset, every interpolated value escaped. Dates in Asia/Ho_Chi_Minh.

## Risks

- Customers who never allowed the bot to message them and decline the prompt get nothing until they start the bot; the account card says so.
- New-IP detection depends on a trusted client IP (see `ip-activity-log`, `TRUST_PRIVATE_PROXY`).
- The bot token remains plaintext in settings (pre-existing).
