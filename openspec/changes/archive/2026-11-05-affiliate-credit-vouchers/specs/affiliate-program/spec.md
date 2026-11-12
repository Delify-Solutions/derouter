## MODIFIED Requirements

### Requirement: Program settings
The admin SHALL control the program with these settings:

| Setting | Default | Allowed values |
| --- | --- | --- |
| `affiliateEnabled` | `false` | boolean |
| `affiliateDefaultRateBp` | `1000` | integer, 0–10000 basis points |
| `affiliateDefaultMaxOrders` | `1` | integer, 0–1000; 0 = every order |
| `affiliateHoldDays` | `7` | integer, 0–365 |
| `affiliateCookieDays` | `30` | integer, 1–365 |
| `affiliateDefaultGiftCodeId` | empty | gift code id, or empty |
| `affiliateVndPerUsd` | `25000` | integer đồng per $1 of credit, 1–10,000,000 |
| `affiliateCreditPlanId` | empty | id of an existing plan, or empty |
| `affiliateCreditDays` | `30` | integer, 1–365 |
| `affiliateMinRedeemVnd` | `10000` | integer đồng, ≥ 0 |
| `affiliateMinRedeemUsdNano` | $1 in nano-USD | integer, ≥ 0 |
| `affiliateBuyerBonusBp` | `0` | integer, 0–10000 basis points; 0 = no bonus |
| `affiliateBuyerBonusMaxOrders` | `1` | integer, 0–1000; 0 = every order |

A value outside its allowed range, or a template plan id that does not exist, SHALL be rejected with HTTP 400 and SHALL leave the stored settings unchanged.

While the program is disabled:
- referral links SHALL NOT attribute;
- no commission SHALL accrue;
- no buyer bonus or referral discount SHALL apply;
- the customer page SHALL show only the existing wallet and vouchers, and no link;
- converting and creating vouchers SHALL be refused. Existing vouchers SHALL stay usable at checkout.

#### Scenario: Out-of-range rate refused
- **WHEN** an admin saves `affiliateDefaultRateBp = 12000`
- **THEN** the response is HTTP 400 and the stored rate is unchanged

#### Scenario: Disabled program accrues nothing
- **WHEN** `affiliateEnabled` is false and a referred customer's order is paid
- **THEN** no commission row is created and the buyer receives no bonus

### Requirement: Hold period
A new commission SHALL be `pending` and SHALL become `available` once `affiliateHoldDays` have passed since accrual. The hold length SHALL be fixed when the commission accrues.

Only available commission SHALL count toward the spendable balance. The system SHALL release due commissions before it reads a wallet or spends from it; no background job is required.

#### Scenario: Held commission is not spendable
- **WHEN** a commission accrued 3 days ago with a 7-day hold
- **THEN** it shows as pending and cannot be converted or turned into a voucher

#### Scenario: Released after hold
- **WHEN** 7 days have passed
- **THEN** the next wallet read shows it as available and adds it to the balance

### Requirement: Refund reverses commission
Refunding an order SHALL reverse its commission in the refund's transaction:
- a `pending` commission SHALL become `reversed` and never be paid;
- an `available` commission SHALL become `reversed`, and a negative wallet entry of the same amount SHALL be recorded, even when that takes the balance below zero.

A negative balance SHALL block converting and creating vouchers in that currency until later commission brings it back to zero or above. Credit already granted and vouchers already created SHALL NOT be taken back.

#### Scenario: Refund during hold
- **WHEN** an order whose commission is still pending is refunded
- **THEN** the commission is reversed and the wallet balance does not change

#### Scenario: Refund after spending
- **WHEN** an order is refunded after its 25,000đ commission was released and converted to credit
- **THEN** the VND balance becomes −25,000đ and a VND conversion is refused

### Requirement: Commission wallet
Each affiliate SHALL have a wallet with a separate balance for VND and for USD.

The balance SHALL be the sum of an append-only wallet ledger:
- released commission;
- reversal;
- conversion to credit;
- voucher creation;
- voucher cancellation refund;
- admin adjustment (with a reason).

`GET /api/account/affiliate` SHALL return, per currency:
- the available balance;
- the pending amount;
- the lifetime earned amount;
- the lifetime spent amount (conversions plus vouchers not cancelled).

#### Scenario: Two currencies kept apart
- **WHEN** an affiliate earned 50,000đ from a VietQR order and $2 from a Binance order
- **THEN** the wallet shows 50,000đ in VND and $2.00 in USD, never a combined figure

### Requirement: Customer affiliate page
`/account/affiliate` ("Giới thiệu") SHALL show:
- the referral link with a copy button;
- the effective commission terms, e.g. "Hoa hồng 10% cho 1 đơn đầu của mỗi người bạn giới thiệu", and the buyer bonus when it is above zero, e.g. "Người được giới thiệu được tặng thêm 5% credit cho 1 đơn đầu";
- the welcome gift code, when one is eligible;
- clicks, signups and paying referrals;
- the wallet per currency;
- the "Đổi thành credit" form, showing the credit the amount will give and its lifetime;
- the "Tạo voucher" form;
- the voucher list;
- the commissions list.

Referred accounts SHALL be shown with masked emails (e.g. `ng***@gmail.com`) and SHALL NOT expose their ids, orders or plans beyond the commission's order amount, currency and date. A used voucher SHALL show who used it only as a masked email.

#### Scenario: Masked referrals
- **WHEN** an affiliate views the referrals list
- **THEN** each referral shows a masked email, the signup date and the commission earned from them

### Requirement: Admin affiliate management
`/dashboard/affiliates` SHALL let an admin:
- edit the program settings;
- list affiliates with their code, overrides, clicks, signups, paying referrals, earned amount per currency and balance per currency;
- set or clear an affiliate's commission rate, commission N, buyer bonus rate, buyer bonus N and gift code overrides;
- block or unblock an affiliate;
- list commissions, filterable by affiliate and status;
- list vouchers, filterable by status, with the owner and, when used, the order and the buyer;
- record a wallet adjustment with a reason.

From the user detail page, an admin SHALL be able to set or clear an account's referrer, with a required reason. The account SHALL NOT be set as its own referrer.

Every admin action on this page SHALL be written to the user audit log of the affected account. Every admin API under `/api/affiliates` SHALL require an admin session.

#### Scenario: Block stops accrual
- **WHEN** an admin blocks affiliate A and then a customer referred by A pays an order
- **THEN** no commission is recorded for A and the customer receives no buyer bonus

#### Scenario: Customer cannot reach admin API
- **WHEN** a request with only a customer session calls `PATCH /api/affiliates/<id>`
- **THEN** the response is HTTP 401 or 403

### Requirement: Account deletion
Deleting an account SHALL:
- remove its affiliate code and wallet;
- cancel its unused vouchers, with no refund since the wallet is gone;
- keep commission rows and used vouchers for accounting;
- never release a held commission of the deleted account into a wallet.

Accounts the deleted account referred SHALL keep `referredByUserId`. No further commission or buyer bonus SHALL arise from the deleted referrer.

#### Scenario: Deleted referrer
- **WHEN** affiliate A is deleted and a customer A referred pays an order
- **THEN** no commission is recorded and no buyer bonus is granted

## REMOVED Requirements

### Requirement: Payout details
**Reason**: Commission is no longer paid out in cash (owner decision).
**Migration**: None. The feature never shipped enabled. Stored payout columns are left unused.

### Requirement: Withdrawal request
**Reason**: Commission is spent only as credit or vouchers (owner decision).
**Migration**: Use "Convert commission to credit" or "Vouchers" instead.

### Requirement: Admin decides withdrawals
**Reason**: No withdrawals exist any more.
**Migration**: None.

## ADDED Requirements

### Requirement: Convert commission to credit
`POST /api/account/affiliate/convert` with `{ currency, amount }` SHALL turn that amount of the affiliate's available balance into API credit when all of these hold:
- the program is enabled;
- the affiliate is not blocked;
- a template plan is set;
- the amount is a whole number of at least that currency's minimum;
- the amount is no more than the available balance.

The credit SHALL be:
- for USD, the amount itself, in nano-USD;
- for VND, `floor(amount × 1e9 / affiliateVndPerUsd)` nano-USD, computed in integer arithmetic.

It SHALL be granted as a separate plan purchase in the same transaction as a negative wallet entry. The grant SHALL use:
- the template plan's id, RPM, TPM and per-window limits;
- that credit, never unlimited;
- source `affiliate`;
- start now, expiry `affiliateCreditDays` later.

Two conversions SHALL produce two independent grants with their own expiry dates. Each failed rule SHALL return its own Vietnamese message with HTTP 400 or 403.

#### Scenario: VND converted at the admin rate
- **WHEN** the rate is 25,000đ per $1 and an affiliate converts 250,000đ
- **THEN** a new plan purchase with $10 credit, the template plan's limits and a 30-day expiry is granted, and the VND balance drops by 250,000đ

#### Scenario: Conversions are not merged
- **WHEN** an affiliate converts $2 on day 1 and $3 on day 10
- **THEN** two separate purchases exist, expiring on day 31 and day 40

#### Scenario: No template plan
- **WHEN** no template plan is set
- **THEN** the conversion is refused and nothing is deducted

### Requirement: Vouchers
`POST /api/account/affiliate/vouchers` with `{ currency, amount }` SHALL create a voucher under the same conditions as a conversion, except that no template plan is needed.

A voucher SHALL have:
- a random 12-character code from the unambiguous alphabet, unique across vouchers and gift codes;
- the currency and amount;
- status `active`.

It SHALL be created in the same transaction as a negative wallet entry of that amount.

The affiliate SHALL be able to cancel an `active` voucher that is not held by a pending or expired order. Cancelling SHALL return the amount to the wallet with a positive ledger entry. A `used` or `cancelled` voucher SHALL NOT change again.

#### Scenario: Create and cancel
- **WHEN** an affiliate with 300,000đ creates a 100,000đ voucher and then cancels it
- **THEN** the balance is 200,000đ after creating and 300,000đ after cancelling

### Requirement: Voucher at checkout
Order creation (VietQR, Binance and manual) SHALL accept an optional `voucherCode`. The voucher SHALL be `active` and not held by another `pending` order; otherwise the order SHALL be refused with "Voucher không hợp lệ hoặc đã được dùng".

The discount SHALL be the voucher amount converted into the order's pay currency, capped at the order's price:
- VND voucher on a USD order: `floor(amount × 1e9 / rate)` nano-USD;
- USD voucher on a VND order: `floor(amount × rate / 1e9)` đồng.

The order SHALL record the voucher and the discount, and the amount to pay SHALL drop by it. The voucher SHALL be held by that order.

When the order is approved, the voucher SHALL become `used`, recording the order, the buyer and the time.

An order whose amount to pay reaches 0 SHALL be approved in the same transaction, with approver `voucher`, and no payment request SHALL be shown.

An expired or cancelled order SHALL release its hold, so the voucher can be used again. Commission SHALL be computed on the discounted amount.

#### Scenario: Voucher lowers a VietQR order
- **WHEN** a customer buys a 250,000đ plan with a 100,000đ voucher
- **THEN** the order asks for 150,000đ, and when it is paid the voucher is `used`

#### Scenario: Voucher covers the whole price
- **WHEN** the voucher is worth more than the order
- **THEN** the order is approved immediately, the plan is granted and the remainder of the voucher is lost

#### Scenario: Voucher already held
- **WHEN** a voucher is held by another pending order
- **THEN** a second order with it is refused

### Requirement: Referred-buyer bonus
A referred customer SHALL receive a bonus on each of their first N paid orders, where N is the referrer's effective buyer bonus N (override ?? `affiliateBuyerBonusMaxOrders`, 0 = every order) and X is the effective buyer bonus rate (override ?? `affiliateBuyerBonusBp`).

The bonus SHALL apply only while all of these hold:
- the program is enabled;
- the referrer exists and is not blocked;
- X > 0.

The count of paid orders SHALL work like commission's first-N rule: other `paid` orders of the buyer, refunded orders excluded.

For an order whose plan has a credit amount, approval SHALL grant `floor(order credit × periods × X / 10000)` nano-USD as a separate purchase, in the approval's transaction. The grant SHALL use:
- the template plan's limits;
- source `referral_bonus`;
- expiry `affiliateCreditDays` after approval.

When no template plan is set, no credit bonus SHALL be granted.

For an unlimited plan, order creation SHALL instead take X% off the price before any voucher, recorded on the order. The order SHALL count toward N when the paid orders plus the pending orders already carrying a referral discount are fewer than N.

The register banner SHALL mention the bonus when X > 0.

#### Scenario: Bonus credit on a credit plan
- **WHEN** X is 10%, N is 1, and a referred customer's first order of a $10-credit plan is paid
- **THEN** they receive the plan plus a separate $1 credit purchase expiring in 30 days

#### Scenario: Discount on an unlimited plan
- **WHEN** X is 10% and a referred customer orders a 500,000đ unlimited plan as their first order
- **THEN** the order asks for 450,000đ

#### Scenario: Only the first N
- **WHEN** N is 1 and the referred customer pays a second order
- **THEN** the second order earns no bonus and no discount
