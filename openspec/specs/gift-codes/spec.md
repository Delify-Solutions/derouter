# gift-codes Specification

## Purpose
Lets the admin give plans or credit through gift codes: codes a customer types on `/account/gift`, top-up plans gifted as an amount of money, and codes the admin gives straight to chosen accounts without the customer typing anything.
## Requirements
### Requirement: Top-up plan gifts carry an amount
A gift code for a plan sold by custom amount (`allowCustomAmount`) MAY carry `amountVnd` (a positive integer of đồng). Redeeming it SHALL grant a purchase of that plan with credit `floor(amountVnd × plan.creditNanoUsd ÷ plan.priceVnd)` — the plan's rate at redemption, without the customer-facing minimum and maximum — and the plan's duration and limits. Without an amount the plan's own credit is granted. `amountVnd` SHALL be refused (HTTP 400, Vietnamese message) on a credit-only code, on a plan not sold by custom amount, or when it buys no credit. The admin form SHALL show the amount field for such plans with the credit it converts to, and the code list SHALL show "plan · amount → credit".

#### Scenario: 250.000đ of Start
- **WHEN** an admin creates a code for "Start" (10.000đ = $10 credit) with `amountVnd = 250000` and a customer redeems it
- **THEN** the customer receives a "Start" purchase with $250 credit, Start's duration and Start's limits

### Requirement: Admin assigns a code to accounts
The admin SHALL be able to give a gift code straight to accounts, without the customer typing it: when creating the code (`POST /api/gift-codes` with `assignUserIds`) or later (`POST /api/gift-codes/[id]/assign` with `userIds` and/or `emails`, at most 200). Each account SHALL be an ordinary redemption — the code's active flag, validity window, total and per-user limits apply and the redemption counts against them — recorded with the admin's identity in `giftRedemptions.assignedBy` and one `gift_assigned` audit row per account. Each account succeeds or fails on its own and the response SHALL list every account with its outcome and, on failure, a Vietnamese reason. The admin UI SHALL pick accounts by searching e-mail or name, raise the total redemptions to the number of picked accounts on creation, show the per-account results, and mark assigned redemptions ("Admin gắn"); the customer's gift history SHALL show "Admin tặng trực tiếp".

#### Scenario: Gift two customers directly
- **WHEN** an admin assigns a "Go" code with 2 redemptions left to a@x and b@x
- **THEN** both receive a "Go" purchase immediately, the code shows 2 more redemptions, and each redemption is marked as assigned by that admin

#### Scenario: Not enough redemptions
- **WHEN** an admin assigns a code with 1 redemption left to two accounts
- **THEN** the first account receives it and the second is listed as "Mã đã hết lượt dùng"

### Requirement: Admin-chosen codes
The admin SHALL be able to type the code when creating it (e.g. `WELCOME2026`). A typed code SHALL contain only unaccented letters, digits, dashes and spaces, SHALL be 4–32 characters once separators are removed, and SHALL be stored upper case without separators. A code that already exists SHALL be refused. An empty field SHALL generate a random 16-character code as before. A code of exactly 16 characters (the generated length) SHALL be displayed in groups of four; a code of any other length SHALL be displayed as stored.

#### Scenario: Welcome code
- **WHEN** an admin creates a code with `welcome-2026`
- **THEN** the code is stored as `WELCOME2026`, listed as `WELCOME2026`, and a customer redeems it by typing `Welcome2026`

#### Scenario: Too short
- **WHEN** an admin types `ABC`
- **THEN** creation is refused with "Mã phải dài từ 4 đến 32 ký tự"

### Requirement: Editing a code
The admin gift code page SHALL offer "Sửa" on every code. It SHALL open the same form as creation, prefilled, and allow editing every field:
- the code string;
- what it grants (plan or custom credit, top-up amount, credit and duration);
- RPM/TPM;
- the total redemptions and the per-user limit;
- the start and expiry dates;
- the new-user flag;
- the note.

The following rules SHALL apply:
- The total SHALL NOT be set below the number of redemptions already made.
- The start SHALL NOT be later than the expiry.
- A new code string SHALL follow the rules for admin-chosen codes, and SHALL NOT match any other code that is not deleted.
- When the promo popup names the code being renamed, the popup SHALL be updated to the new string in the same write.

A change SHALL apply to redemptions made after it. Purchases already granted by the code SHALL keep what they received. The dialog SHALL say so when the code has been redeemed.

#### Scenario: More uses for an exhausted code
- **WHEN** a code with 2 of 2 uses taken is edited to 5 uses
- **THEN** three more accounts can redeem it

#### Scenario: Gift changed after redemption
- **WHEN** an admin changes a redeemed $5 credit code to $50
- **THEN** the next redeemer receives $50 and the earlier redeemers keep their $5 purchases

#### Scenario: Rename a code
- **WHEN** an admin renames code OLDNAME to NEWNAME
- **THEN** NEWNAME can be redeemed and OLDNAME is reported as not existing

#### Scenario: Rename the popup's code
- **WHEN** the promo popup shows code OLDNAME and an admin renames it to NEWNAME
- **THEN** the popup shows NEWNAME

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

### Requirement: Gift code rates
A gift code SHALL carry optional `rpm` and `tpm`, entered in the create and edit form: empty = the plan's own (none for a credit gift), 0 = no limit, or a positive integer. Each purchase the code grants SHALL carry these values as its per-purchase rate override (spec plan-templates "Per-purchase rate override"). The code list SHALL show them when set.

#### Scenario: Rate-limited credit gift
- **WHEN** an admin creates a $5 credit code with RPM 15 and a customer redeems it
- **THEN** the customer's new purchase is limited to 15 requests a minute while it pays

### Requirement: Delete a gift code
The admin gift code page SHALL offer "Xóa" on every code, with a confirmation that states the outcome.

- **A code nobody redeemed** SHALL be removed.
- **A redeemed code** SHALL be soft-deleted, with these effects:
  - it disappears from the admin list and from the affiliate gift picker;
  - it can no longer be redeemed, assigned or edited;
  - its redemption history and the purchases it granted SHALL stay unchanged, and the history SHALL still show the code as customers typed it;
  - its string SHALL become free, so a new code may use it.

In both cases the code SHALL be unlinked, in the same transaction, from every place that uses it: the referral program's default welcome gift and the promo popup code SHALL be cleared, and each CTV's welcome-gift override SHALL be cleared and audited on that CTV. The confirmation SHALL name those places before the admin confirms, and the result SHALL say what was unlinked.

The on/off switch SHALL remain for pausing a code without deleting it.

#### Scenario: Unused code removed
- **WHEN** an admin deletes a code with 0 redemptions
- **THEN** the code no longer exists

#### Scenario: Used code hidden
- **WHEN** an admin deletes a code redeemed 3 times
- **THEN** it is gone from the list, entering it reports that the code does not exist, and the 3 redeemers keep their purchases

#### Scenario: Recreate a deleted string
- **WHEN** an admin deletes the redeemed code WELCOME and then creates a new code WELCOME
- **THEN** the new code is created, redeeming WELCOME uses the new code, and the old redemptions still show WELCOME

#### Scenario: Code in use is unlinked
- **WHEN** an admin deletes a code that is the referral default gift, the welcome gift of 2 CTVs and the popup code
- **THEN** the dialog lists those places, and after deleting the default gift and the popup code are empty and neither CTV has its own gift any more
