## ADDED Requirements

### Requirement: Bot receives commands securely
The bot SHALL receive updates only through a webhook whose requests carry the secret token set when the admin enabled it; a request without it SHALL be refused. The secret SHALL NOT be readable or writable through the settings API. Only private chats SHALL be answered.

#### Scenario: Forged update
- **WHEN** a request reaches the webhook without the secret header
- **THEN** it is refused and nothing is done

### Requirement: Customer commands
A Telegram user linked to an account SHALL be able to see the account's credit, plans and expiry (`/me`), usage for today and 7 days (`/usage`), listed gift codes with take buttons (`/gifts`), redeem a code (`/gift CODE`) under the same rules as the web, the plan catalogue with a link to buy (`/plans`), their API keys by prefix only (`/keys`), and turn notification groups on or off or unlink (`/settings`). An unlinked Telegram user SHALL be told how to link.

#### Scenario: Redeem in the bot
- **WHEN** a linked customer sends `/gift WELCOME2026`
- **THEN** the code is redeemed for that account exactly as on the web and the reply shows what was granted

#### Scenario: Not linked
- **WHEN** an unlinked Telegram user sends `/me`
- **THEN** the bot explains how to link and shows no account data

### Requirement: Admin commands
Telegram users whose ids the admin listed SHALL be able to see today's figures (`/stats`), list pending orders and approve or cancel them with a confirmation tap (`/orders`), and look up an account (`/user`). Anyone else SHALL get the same answer as for an unknown command. An approval SHALL record the Telegram admin as the approver and notify the customer; a cancellation SHALL be audited.

#### Scenario: Approve from Telegram
- **WHEN** a listed admin taps "Duyệt" and then "Xác nhận duyệt" on a pending order
- **THEN** the order is paid, the customer receives the plan, and the approver is `telegram:<id>`

#### Scenario: Customer tries an admin command
- **WHEN** a customer sends `/stats`
- **THEN** the bot answers that there is no such command
