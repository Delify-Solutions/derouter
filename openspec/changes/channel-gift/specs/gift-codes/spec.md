## ADDED Requirements

### Requirement: Channel-join codes
A gift code MAY be a channel-join code. It SHALL be redeemable by any account
(new or not) whose linked Telegram user is a member of the admin's Telegram
channel, checked with the bot at redemption time. Each Telegram user SHALL take a
given channel-join code at most once across all accounts, and each account at most
once. A code SHALL NOT be both a new-user code and a channel-join code. If the
membership cannot be checked, the redemption SHALL be refused as temporarily
unavailable, not as "not a member". An admin assignment skips the check.

#### Scenario: Member redeems
- **WHEN** an account linked to Telegram user T, who is in the channel, redeems the code
- **THEN** the grant is applied and the redemption records T

#### Scenario: Not in the channel
- **WHEN** the linked Telegram user is not in the channel
- **THEN** the redemption is refused with `channel_required` and the channel link

#### Scenario: Same Telegram user on another account
- **WHEN** T moves to another account and redeems the same code there
- **THEN** it is refused with `telegram_channel_used`

#### Scenario: Bot cannot read the channel
- **WHEN** Telegram answers that the chat is unavailable
- **THEN** the customer gets a "try again later" error and nothing is granted

### Requirement: Listed codes on the gift page
The admin MAY mark a code as listed. The customer gift page SHALL show, under "Mã
có thể sử dụng", each listed code that is active, in its window, not exhausted,
has a valid grant, and that this account can still take, with a button to take it.
A code that only needs a Telegram link SHALL show the link prompt instead.

#### Scenario: Taken code disappears
- **WHEN** the customer takes a listed code up to its per-account limit
- **THEN** it is no longer listed for that account

### Requirement: Channel offer after the welcome code
After an account takes a new-user code, if a channel-join code it can still take
exists and the channel is configured, the gift page SHALL show a dialog inviting
the customer to join the channel and take that voucher.

#### Scenario: Welcome then channel
- **WHEN** a new account takes the welcome code
- **THEN** a dialog offers the channel voucher with "Mở kênh Telegram" and "Tôi đã tham gia, nhận ngay"
