## ADDED Requirements

### Requirement: Customer notifications over Telegram
The system SHALL send messages from the configured bot to the Telegram user linked to an account, in Vietnamese, for these groups:
- `billing`: an order approved by an admin, by a payment webhook, by the payment poller or by an admin assigning a payment; a plan or credit granted by an admin; a gift code redeemed by the customer or assigned by an admin;
- `expiry`: the reminders in "Plan and credit reminders";
- `security`: a successful login from an IP never seen on an earlier `login` or `register` of the account (not on the first login); a password change or reset (by the customer or an admin); an API key created; the account suspended, or reactivated from suspended; the Telegram account linked;
- `announcements`: admin broadcasts.

Messages other than `security` SHALL be sent only to active accounts. Sending SHALL happen after the triggering change is committed and SHALL never fail or delay the triggering request. Values inserted into a message SHALL be HTML-escaped.

#### Scenario: Payment approved
- **WHEN** a gateway payment matches a linked customer's order
- **THEN** the customer receives "Thanh toán thành công" with the plan, credit and expiry

#### Scenario: Telegram down
- **WHEN** Telegram cannot be reached while an admin approves an order
- **THEN** the approval succeeds and the response is not delayed by the notification

#### Scenario: Login from a new IP
- **WHEN** an account that previously logged in from IP A logs in from IP B
- **THEN** the customer receives "Đăng nhập từ địa chỉ mới" with IP B

### Requirement: Notification preferences
A linked customer SHALL be able to turn `billing`, `expiry` and `announcements` on or off on `/account`; all are on by default. `security` messages SHALL always be sent. `GET /api/account/telegram` SHALL return `notifyPrefs`, `dmBlocked` and `botUsername`; `PATCH /api/account/telegram { notifyPrefs }` SHALL update only known groups with boolean values.

#### Scenario: Billing turned off
- **WHEN** a customer turns billing off and an order is approved
- **THEN** no message is sent, while a later password change is still notified

### Requirement: Refused delivery
When Telegram answers 403, or 400 "chat not found", the account SHALL be marked (`telegramDmBlockedAt`) and further messages skipped until a forced message is delivered. The test message (`POST /api/account/telegram/test`, rate limited) and the link confirmation SHALL be forced. A delivered message, a new link or an unlink SHALL clear the mark. While marked, `/account` SHALL say that the bot cannot reach the customer and link to the bot.

#### Scenario: Customer blocked the bot
- **WHEN** a message to a customer returns 403
- **THEN** the account is marked, later non-forced messages are not attempted, and `/account` shows the warning with "Mở bot Telegram"

#### Scenario: Customer unblocks
- **WHEN** the marked customer starts the bot and presses "Gửi tin thử"
- **THEN** the test message is delivered and the mark is cleared

### Requirement: Write access at link time
The Mini App SHALL request permission for the bot to message the user (`requestWriteAccess`, when supported and not already granted) before posting `initData`, and the server SHALL send a forced link confirmation after linking.

#### Scenario: Linking grants messaging
- **WHEN** a customer links Telegram and allows the bot to message them
- **THEN** they receive "Đã liên kết Telegram" in the bot chat

### Requirement: Plan and credit reminders
Every 10 minutes the system SHALL send, once each, to linked, reachable, active accounts with `expiry` on:
- `expire_3d` for an active, started plan ending within 3 days and `expire_1d` when within 24 hours, unless another active plan of the account ends later, and only when the plan lasts longer than that window (a 2-day gift gets only the 24-hour reminder, a 1-day grant none); once `expire_1d` is sent, `expire_3d` SHALL not be sent; a plan whose end date changes (an extension) SHALL be reminded again;
- `credit_low` when, across the account's started, unexpired plans, the remaining credit of active plans is under 10% of their total credit, unless an unlimited plan is active; it SHALL be sent again only after a newer plan joins the running set (a purchase), not when an older plan drops out.

A reminder that could not be delivered for a transient reason (network, flood limit, bot not configured) SHALL be retried on the next run; other Telegram errors SHALL not be retried. `DISABLE_TELEGRAM_REMINDERS=true` SHALL turn the job off.

#### Scenario: Renewal queued
- **WHEN** a plan ends in 2 days and a renewal starts when it ends
- **THEN** no expiry reminder is sent

#### Scenario: One reminder only
- **WHEN** the job runs twice while a plan has 12 hours left
- **THEN** the customer receives one "Gói hết hạn trong 24 giờ"

### Requirement: Admin announcements
The admin page "Thông báo Telegram" (`/dashboard/telegram`) SHALL show how many accounts are linked, will receive the message (linked, active, not marked, announcements on) and are marked, let the admin compose 1–3500 characters of plain text, confirm, and send it in the background; and list recent broadcasts with status (`sending`, `done`, `failed`, `interrupted`) and sent / failed / skipped / total counts, where skipped means the customer turned announcements off or the account stopped being active during the run. Only one broadcast SHALL run at a time. A broadcast cut short by a restart SHALL show as `interrupted` and SHALL not resume.

#### Scenario: Maintenance notice
- **WHEN** the admin sends "Bảo trì 23:00" with 120 recipients
- **THEN** each recipient receives it once and the history row ends `done` with the counts
