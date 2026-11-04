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
The admin gift code page SHALL offer "Sửa" on every code, editing the total redemptions, the per-user limit, the start and expiry dates, the new-user flag and the note. The total SHALL NOT be set below the number of redemptions already made. Once a code has been redeemed, what it grants (plan, credit, amount, duration) SHALL NOT change; the code string itself is never editable.

#### Scenario: More uses for an exhausted code
- **WHEN** a code with 2 of 2 uses taken is edited to 5 uses
- **THEN** three more accounts can redeem it

#### Scenario: Gift locked after redemption
- **WHEN** an admin tries to change the credit of a code that was already redeemed
- **THEN** the save is refused with "Mã đã có người dùng nên không đổi được quà tặng"
