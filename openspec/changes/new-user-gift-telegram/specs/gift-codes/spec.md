## ADDED Requirements

### Requirement: New-user codes
A gift code MAY be flagged `newUserOnly`. Such a code SHALL have `perUserLimit = 1`. A customer typing it SHALL be refused, after the code's active flag, window and total limit are checked, in this order:
1. `already_redeemed`: this account already redeemed this code (HTTP 409);
2. `not_new_user`: the account has a purchase grant (`userPlans.source = 'purchase'`) or has redeemed any other `newUserOnly` code (HTTP 409, "Mã này chỉ dành cho tài khoản mới.");
3. `telegram_required`: the account has no linked Telegram user (HTTP 403, `code: "telegram_required"`, "Mã dành cho tài khoản mới, cần liên kết Telegram để nhận.");
4. `telegram_used`: a redemption of any `newUserOnly` code already carries this Telegram user id (HTTP 409, "Tài khoản Telegram này đã nhận ưu đãi người mới.").

These checks SHALL run inside the redemption transaction. A redemption SHALL store the account's `telegramUserId` (when linked), and that stored id, not the account's current link, decides `telegram_used`. A code assigned by an admin SHALL skip checks 2–4 but still store the Telegram user id.

When the refusal is `telegram_required`, `/account/gift` SHALL keep the code, show the message with a "Liên kết Telegram" button, wait for the link (as on `/account`) and then redeem the code without another click. No other refusal SHALL show that button.

The admin gift form SHALL offer "Mã người mới (cần liên kết Telegram)", fixing the per-account limit at 1. The code list SHALL tag such codes "Người mới", and the redemption list SHALL show the Telegram user of each redemption.

#### Scenario: Welcome code for a linked new account
- **WHEN** an account with no purchase and a linked Telegram user types a new-user code
- **THEN** the gift is granted and the redemption stores the Telegram user id

#### Scenario: Not linked yet
- **WHEN** a new account without Telegram types a new-user code
- **THEN** the response is HTTP 403 `telegram_required` and nothing is granted

#### Scenario: Second account, same Telegram
- **WHEN** Telegram user 42 redeemed a new-user code on account A, then unlinks, links account B and types any new-user code
- **THEN** B is refused with `telegram_used`

#### Scenario: Already bought a plan
- **WHEN** an account with a paid purchase types a new-user code
- **THEN** it is refused with `not_new_user` and no link button is shown

#### Scenario: Admin assigns a welcome code
- **WHEN** an admin assigns a new-user code to an account without Telegram
- **THEN** the account receives it
