# telegram-support Specification

## Purpose
Lets a customer reach the owner over the bot that already sends them
notifications, and lets the owner answer from Telegram or the dashboard.
## Requirements
### Requirement: A customer can reach the admin through the bot
A customer whose account is linked to a Telegram user SHALL be able to send the bot free text and have it relayed to the admin chat. The bot SHALL answer `/help` (and `/start`, `/hotro`) with instructions that the chat itself is the support channel, and those commands SHALL NOT be relayed. Every other text message SHALL be stored with the sending account and forwarded to the admin chat carrying the customer's display name, a masked email (`a***@domain`), the Telegram username and the message body. The customer SHALL receive a one-line confirmation that the message reached the admin. HTML in the message SHALL be escaped, never interpreted.

#### Scenario: Customer asks a question
- **WHEN** a linked customer writes "Gói của em hết hạn ngày nào?"
- **THEN** the admin chat receives the message with the customer's name, masked email and @username, and the customer's chat receives "Đã gửi tới admin"

#### Scenario: /help
- **WHEN** a linked customer sends `/help`
- **THEN** the bot explains that they can type their question in this chat, and nothing is relayed to the admin

#### Scenario: Message that is not text
- **WHEN** a customer sends a photo, sticker or file
- **THEN** nothing is forwarded and nothing is stored, and the bot answers that only text is read

#### Scenario: The relay fails
- **WHEN** the relay to the admin chat cannot be delivered
- **THEN** nothing is stored and the customer is told the message did not arrive, so no one believes it was delivered

#### Scenario: A command is not a message
- **WHEN** a customer sends `/help`
- **THEN** it does not appear in the conversation and does not count as unread

### Requirement: An unlinked or suspended chat gets an answer, not silence
A message from a Telegram user with no linked account SHALL be answered with how to link one, and SHALL NOT be stored or relayed. A message from an account that is not `active` SHALL be answered with a message saying the support chat is unavailable while suspended, and SHALL NOT be stored or relayed.

#### Scenario: Stranger found the bot
- **WHEN** someone who never linked an account sends "cho em hỏi"
- **THEN** the bot answers that the Telegram account is not linked and how to link it, and the admin receives nothing

#### Scenario: Suspended account
- **WHEN** a suspended customer sends a message
- **THEN** the bot says the account is suspended and the admin receives nothing

### Requirement: The admin answers with a Telegram reply
A message in the configured admin chat that is a reply to a relayed support message SHALL be delivered to that customer's Telegram chat and stored as an outgoing message. A message in the admin chat that replies to nothing the bot relayed SHALL be ignored. The mapping from a relayed admin-chat message to its account SHALL survive a restart.

#### Scenario: Admin replies
- **WHEN** an admin replies "Gói của bạn hết hạn 10/12" to a relayed message
- **THEN** that customer's chat receives the text and the conversation in the dashboard shows it as outgoing

#### Scenario: The admin chat is a group
- **WHEN** the configured admin chat is a group (`-100…`) and the admin replies there
- **THEN** the answer is routed like any other reply, because the private-chat rule applies only to customers

#### Scenario: The answer is refused
- **WHEN** Telegram refuses the answer for any reason (blocked, flood limit, outage)
- **THEN** the admin chat is told the answer did not arrive and the answer is not stored

#### Scenario: Unrelated admin message
- **WHEN** an admin types in the admin chat without replying to a relayed message
- **THEN** nothing is sent to any customer and nothing is stored

### Requirement: The dashboard shows and answers the same conversations
`/dashboard/telegram` SHALL show a support section listing one row per account with a conversation, newest first, with the last message, its direction, the time and the number of customer messages not yet opened. Opening a conversation SHALL show its messages oldest first and SHALL mark the customer's messages of that account as read. The section SHALL offer a reply box that delivers the text to the customer's Telegram chat through the same path as a Telegram reply, and SHALL report a delivery failure instead of hiding it.

#### Scenario: Unread count
- **WHEN** a customer sends two messages and the admin has not opened the conversation
- **THEN** its row shows 2 and the section summary shows 2 unread

#### Scenario: Opening clears the count
- **WHEN** the admin opens that conversation
- **THEN** its unread count becomes 0 and stays 0 after a reload

#### Scenario: Polling does not mark read
- **WHEN** an open conversation is refreshed on a timer while the admin is away
- **THEN** nothing is marked read, so a message that arrives meanwhile still shows as unread

#### Scenario: Answering from the dashboard
- **WHEN** the admin types an answer and sends it from the panel
- **THEN** the customer receives it on Telegram and it appears in the thread

#### Scenario: Delivery fails
- **WHEN** Telegram refuses the answer
- **THEN** the panel reports the failure and the message is NOT added to the thread

### Requirement: One reader, no duplicates, no replay
The bot's updates SHALL be read by a single long-polling loop with `allowed_updates: ["message"]`. The next offset SHALL be persisted before a batch is handled, so a restart neither replays delivered messages nor loses the position. An update whose message was already stored SHALL NOT be stored, relayed or charged to the customer's rate budget again. Inbound idempotency SHALL be keyed on `(account, direction, telegram message id)`, because the customer's chat and the admin chat number their messages independently. `DISABLE_TELEGRAM_SUPPORT=true` SHALL turn the loop off, and it SHALL NOT run during a build. When Telegram answers `409 Conflict` (a webhook or another reader owns the stream) the loop SHALL back off instead of retrying tightly.

#### Scenario: Re-delivered update
- **WHEN** Telegram sends the same update twice
- **THEN** the message appears once in the conversation and is relayed to the admin once

#### Scenario: Restart
- **WHEN** the server restarts after handling updates
- **THEN** the next poll asks for the messages after the last one handled, and no message is delivered twice

#### Scenario: Webhook configured
- **WHEN** Telegram answers `409 Conflict`
- **THEN** the loop waits minutes rather than seconds before asking again

### Requirement: One customer cannot spend the bot's quota
Inbound messages SHALL be limited per Telegram user (`20` per `10` minutes). Beyond the limit the bot SHALL answer that the customer should wait rather than relay, so one customer flooding the bot cannot exhaust the bot-wide Telegram rate limit and silence notifications for everyone else. A re-delivered update SHALL NOT spend the budget.

#### Scenario: Flood
- **WHEN** one customer sends more messages than the limit within the window
- **THEN** the extra messages are answered with a wait notice and are not relayed, and other customers are unaffected

### Requirement: Deleting an account removes its conversation
Deleting a customer account SHALL delete its `supportMessages` rows and its relay mappings, so customer-written text never outlives a deletion request.

#### Scenario: Account deleted
- **WHEN** an admin deletes an account that had a support conversation
- **THEN** no support message and no relay mapping for that account remains

### Requirement: The account page opens the chat
The Telegram card on `/account`, once the account is linked, SHALL show a control that opens `https://t.me/<botUsername>?start=help`. It SHALL be hidden when no bot username is configured, with a short explanation instead.

#### Scenario: Linked customer
- **WHEN** the account is linked and the bot username is set
- **THEN** the card offers "Nhắn admin trên Telegram" linking to the bot with `start=help`

#### Scenario: No bot username
- **WHEN** no bot username is configured
- **THEN** the card says the support chat is not available instead of showing a dead link
