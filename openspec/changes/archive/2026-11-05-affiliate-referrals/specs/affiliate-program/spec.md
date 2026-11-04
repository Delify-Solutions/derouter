## Purpose

Lets customers and collaborators (CTV) refer new buyers through a personal link, earn a configurable commission on the first orders those buyers pay, and withdraw it. The link can also advertise a Telegram-verified welcome gift code.

## ADDED Requirements

### Requirement: Program settings
The admin SHALL control the program with these settings:

| Setting | Default | Allowed values |
| --- | --- | --- |
| `affiliateEnabled` | `false` | boolean |
| `affiliateDefaultRateBp` | `1000` | integer, 0–10000 basis points |
| `affiliateDefaultMaxOrders` | `1` | integer, 0–1000; 0 = every order |
| `affiliateHoldDays` | `7` | integer, 0–365 |
| `affiliateCookieDays` | `30` | integer, 1–365 |
| `affiliateMinWithdrawVnd` | `100000` | integer đồng, ≥ 0 |
| `affiliateMinWithdrawUsdNano` | $5 in nano-USD | integer, ≥ 0 |
| `affiliateDefaultGiftCodeId` | empty | gift code id, or empty |

A value outside its allowed range SHALL be rejected with HTTP 400 and SHALL leave the stored settings unchanged.

While the program is disabled:
- referral links SHALL NOT attribute;
- no commission SHALL accrue;
- the customer page SHALL show only an existing wallet and withdrawal history, and no link.

#### Scenario: Out-of-range rate refused
- **WHEN** an admin saves `affiliateDefaultRateBp = 12000`
- **THEN** the response is HTTP 400 and the stored rate is unchanged

#### Scenario: Disabled program accrues nothing
- **WHEN** `affiliateEnabled` is false and a referred customer's order is paid
- **THEN** no commission row is created

### Requirement: One referral code per account
A customer SHALL get a referral code the first time the customer opens the affiliate page while the program is enabled.

The code SHALL be:
- 6–10 characters from an unambiguous uppercase alphabet (no `0`, `O`, `1`, `I`, `L`);
- generated with a cryptographic RNG;
- unique across accounts;
- unchanged for the life of the account.

The referral link SHALL be `<public base URL>/r/<CODE>`. Codes SHALL be matched case-insensitively.

#### Scenario: Code is stable
- **WHEN** a customer opens `/account/affiliate` twice
- **THEN** both visits show the same code and link

### Requirement: Referral link redirect
`GET /r/<CODE>` SHALL be public. Its behaviour depends on the code:

- **Valid code**: the program is enabled and the code belongs to a non-blocked affiliate.
  - It SHALL set the cookie `dr_ref=<CODE>` (`HttpOnly`, `SameSite=Lax`, `Secure` on HTTPS, Max-Age = `affiliateCookieDays`).
  - It SHALL redirect (302) to `/register?ref=<CODE>`.
  - It SHALL increment the affiliate's click counter, at most once per browser: no increment when the request already carries `dr_ref` with the same code.
  - A newer valid link SHALL replace an older cookie (last click wins).
- **Any other code**: it SHALL redirect to `/register` without setting a cookie or counting a click.

#### Scenario: Valid link
- **WHEN** a visitor without cookies opens `/r/k7q2mz` for an active affiliate whose code is `K7Q2MZ`
- **THEN** the response is 302 to `/register?ref=K7Q2MZ`, sets `dr_ref=K7Q2MZ`, and the affiliate's clicks go up by one

#### Scenario: Repeat click not counted
- **WHEN** the same visitor opens the link again with `dr_ref=K7Q2MZ` already set
- **THEN** the click counter is unchanged

#### Scenario: Blocked affiliate
- **WHEN** the affiliate is blocked
- **THEN** the response redirects to `/register` and sets no cookie

### Requirement: Effective terms per affiliate
An affiliate's effective commission rate, order count N and welcome gift code SHALL each be the affiliate's own override when one is set, otherwise the program default.

Overrides:
- The rate and N overrides SHALL use the same ranges as the defaults.
- Clearing an override SHALL fall back to the default.

The terms SHALL be read when a commission accrues. Changing them SHALL NOT alter commissions already recorded.

#### Scenario: CTV override
- **WHEN** the default rate is 10% and affiliate A has an override of 25%
- **THEN** a paid order of 200,000đ by A's referral earns A 50,000đ

#### Scenario: Later change does not rewrite history
- **WHEN** A's rate is changed from 25% to 5% after a commission of 50,000đ was recorded
- **THEN** that commission stays 50,000đ

### Requirement: Commission accrues when a referred order is paid
When an order transitions to `paid` on any approval path (gateway reconciliation or admin approval, including late approval of an expired order), the system SHALL record a commission for the buyer's referrer, in the same database transaction as the approval, when all of these hold:
- the program is enabled;
- the buyer has a referrer;
- the referrer's account exists and the referrer is not blocked;
- the referrer is not the buyer;
- the order is within the first N paid orders (see "First N orders");
- the computed amount is greater than zero.

At most one commission SHALL exist per order. Approving an already-paid order SHALL NOT create a second one.

Each commission SHALL record:
- the order;
- the referrer and the buyer;
- the currency;
- the base amount, the rate applied and the commission amount;
- the time it becomes available.

#### Scenario: Gateway-paid order earns commission
- **WHEN** a referred customer's VietQR order of 250,000đ is matched by the payment poller and the referrer's rate is 10%
- **THEN** a commission of 25,000đ (VND) is recorded in the same transaction that marks the order paid

#### Scenario: Duplicate approval
- **WHEN** the same order is approved twice (webhook and poll race)
- **THEN** exactly one commission exists for it

#### Scenario: Unreferred buyer
- **WHEN** a customer without a referrer pays an order
- **THEN** no commission is recorded

### Requirement: First N orders per referred customer
A paid order SHALL earn commission only when the buyer has fewer than N other orders in status `paid`, where N is the referrer's effective N. N = 0 SHALL mean no limit.

The count SHALL include paid orders that earned nothing: orders paid while the program was disabled, while the referrer was blocked, or before an admin set the referrer. A refunded order SHALL NOT count, so it frees its place for the buyer's next paid order.

#### Scenario: First order only
- **WHEN** N is 1 and a referred customer pays a first and then a second order
- **THEN** only the first order earns commission

#### Scenario: Five orders
- **WHEN** N is 5 and the customer pays six orders
- **THEN** the first five earn commission and the sixth does not

#### Scenario: Order paid while blocked uses its place
- **WHEN** N is 1, the buyer's first order is paid while the referrer is blocked, the referrer is unblocked, and the buyer pays a second order
- **THEN** neither order earns commission

#### Scenario: Refund frees the slot
- **WHEN** N is 1, the first order's commission was reversed by a refund, and the customer pays another order
- **THEN** that order earns commission

### Requirement: Commission currency and base amount
The commission SHALL be computed in the currency the customer actually paid. No exchange rate SHALL be applied.

| Order paid in | Base amount | Commission currency |
| --- | --- | --- |
| VND (VietQR) | the order's pay amount in đồng | VND |
| USDT (Binance) | the order's pay amount, 1 USDT = 1 USD | USD, nano-USD |
| Manual, or no pay currency | the order's USD amount | USD, nano-USD |

The amount SHALL be `floor(base × rateBp / 10000)` in integer arithmetic. Floats SHALL NOT be used.

#### Scenario: USDT order
- **WHEN** an order paid with 10 USDT earns commission at 1500 bp
- **THEN** the commission is $1.50 (1,500,000,000 nano-USD) in USD

#### Scenario: Rounding
- **WHEN** a VND order of 99,999đ earns commission at 1000 bp
- **THEN** the commission is 9,999đ

### Requirement: Hold period
A new commission SHALL be `pending` and SHALL become `available` once `affiliateHoldDays` have passed since accrual. The hold length SHALL be fixed when the commission accrues.

Only available commission SHALL count toward the withdrawable balance. The system SHALL release due commissions before it reads a wallet or accepts a withdrawal request; no background job is required.

#### Scenario: Held commission is not withdrawable
- **WHEN** a commission accrued 3 days ago with a 7-day hold
- **THEN** it shows as pending and is not part of the withdrawable balance

#### Scenario: Released after hold
- **WHEN** 7 days have passed
- **THEN** the next wallet read shows it as available and adds it to the balance

### Requirement: Refund reverses commission
Refunding an order SHALL reverse its commission in the refund's transaction:
- A `pending` commission SHALL become `reversed` and never be paid.
- An `available` commission SHALL become `reversed`, and a negative wallet entry of the same amount SHALL be recorded, even when that takes the balance below zero.

A negative balance SHALL block withdrawals in that currency until later commission brings it back to zero or above.

#### Scenario: Refund during hold
- **WHEN** an order whose commission is still pending is refunded
- **THEN** the commission is reversed and the wallet balance does not change

#### Scenario: Refund after payout
- **WHEN** an order is refunded after its 25,000đ commission was released and withdrawn
- **THEN** the VND balance becomes −25,000đ and a VND withdrawal request is refused

### Requirement: Commission wallet
Each affiliate SHALL have a wallet with a separate balance for VND and for USD.

The balance SHALL be the sum of an append-only wallet ledger:
- released commission;
- reversal;
- withdrawal reserve;
- withdrawal rejection refund;
- admin adjustment (with a reason).

`GET /api/account/affiliate` SHALL return, per currency:
- the available balance;
- the pending amount;
- the lifetime earned amount;
- the lifetime withdrawn amount.

#### Scenario: Two currencies kept apart
- **WHEN** an affiliate earned 50,000đ from a VietQR order and $2 from a Binance order
- **THEN** the wallet shows 50,000đ in VND and $2.00 in USD, never a combined figure

### Requirement: Payout details
An affiliate SHALL be able to save payout details:
- VND: bank name, account number and account holder name, each required, trimmed, at most 100 characters;
- USD: a USDT (TRC20/BEP20) address or Binance Pay ID, and the network.

Payout details SHALL be shown only to that affiliate and to admins.

#### Scenario: Missing bank field
- **WHEN** an affiliate saves VND details without an account number
- **THEN** the response is HTTP 400

### Requirement: Withdrawal request
`POST /api/account/affiliate/withdrawals` SHALL create a withdrawal for one currency and amount when all of these hold:
- the program is enabled;
- the affiliate is not blocked;
- payout details for that currency are saved;
- the amount is an integer of at least that currency's minimum;
- the amount is no more than the available balance;
- the affiliate has no other `pending` withdrawal in that currency.

The request SHALL snapshot the payout details. In the same transaction, it SHALL write a negative ledger entry that reserves the amount. The admin SHALL be notified on Telegram without any secret.

Each failed rule SHALL return HTTP 400 or 403 with its own Vietnamese message.

#### Scenario: Valid request
- **WHEN** an affiliate with 300,000đ available requests 200,000đ
- **THEN** a pending withdrawal exists and the available VND balance is 100,000đ

#### Scenario: Below minimum
- **WHEN** the amount is below `affiliateMinWithdrawVnd`
- **THEN** the response is HTTP 400 and nothing is reserved

#### Scenario: Concurrent requests
- **WHEN** two requests for the full balance arrive at once
- **THEN** exactly one succeeds

### Requirement: Admin decides withdrawals
An admin SHALL be able to decide a `pending` withdrawal in one of two ways:
- mark it `paid`, with a transfer reference of at most 200 characters;
- mark it `rejected`, with a reason. Rejection SHALL return the reserved amount to the balance with a positive ledger entry in the same transaction.

A decided withdrawal SHALL NOT be decided again. Each decision SHALL record the admin and the time.

#### Scenario: Reject returns funds
- **WHEN** an admin rejects a 200,000đ pending withdrawal
- **THEN** the affiliate's VND balance goes back up by 200,000đ

#### Scenario: Double decision
- **WHEN** a second admin tries to mark an already-paid withdrawal as rejected
- **THEN** the response is HTTP 409 and the balance is unchanged

### Requirement: Referral welcome gift
An affiliate's effective welcome gift code (see "Effective terms per affiliate") SHALL be selectable only when it is an existing gift code flagged new-user. Saving any other code as the default or as an override SHALL return HTTP 400.

When the code is shown, it SHALL be shown only while it is active, inside its validity window and not exhausted. Redeeming it SHALL follow the existing new-user gift rules unchanged, including the linked-Telegram requirement and one new-user code per Telegram user.

For a logged-in account whose referrer has an eligible gift code, and which has not redeemed that code yet:
- `/account/gift` SHALL show the code and prefill it in the redeem form;
- it SHALL show the "Liên kết Telegram" action when the account is not linked.

#### Scenario: Non-new-user code refused
- **WHEN** an admin sets the default referral gift to a code with `newUserOnly = 0`
- **THEN** the response is HTTP 400

#### Scenario: Referred account sees its gift
- **WHEN** a referred account without Telegram opens `/account/gift`
- **THEN** the referral code is prefilled, and redeeming it prompts the Telegram link as for any new-user code

### Requirement: Customer affiliate page
`/account/affiliate` ("Giới thiệu") SHALL show:
- the referral link with a copy button;
- the effective rate and N, phrased e.g. "Hoa hồng 10% cho 1 đơn đầu của mỗi người bạn giới thiệu";
- the welcome gift code, when one is eligible;
- clicks, signups and paying referrals;
- the wallet per currency;
- payout details;
- the withdrawal form;
- the withdrawal history;
- the commissions list.

Referred accounts SHALL be shown with masked emails (e.g. `ng***@gmail.com`) and SHALL NOT expose their ids, orders or plans beyond the commission's order amount, currency and date.

#### Scenario: Masked referrals
- **WHEN** an affiliate views the referrals list
- **THEN** each referral shows a masked email, the signup date and the commission earned from them

### Requirement: Admin affiliate management
`/dashboard/affiliates` SHALL let an admin:
- edit the program settings;
- list affiliates with their code, overrides, clicks, signups, paying referrals, earned amount per currency and balance per currency;
- set or clear an affiliate's rate, N and gift code overrides;
- block or unblock an affiliate;
- list commissions (filterable by affiliate and status);
- list and decide withdrawals;
- record a wallet adjustment with a reason.

From the user detail page, an admin SHALL be able to set or clear an account's referrer, with a required reason. The account SHALL NOT be set as its own referrer.

Every admin action on this page SHALL be written to the user audit log of the affected account. Every admin API under `/api/affiliates` SHALL require an admin session.

#### Scenario: Block stops accrual
- **WHEN** an admin blocks affiliate A and then a customer referred by A pays an order
- **THEN** no commission is recorded for A

#### Scenario: Customer cannot reach admin API
- **WHEN** a request with only a customer session calls `PATCH /api/affiliates/<id>`
- **THEN** the response is HTTP 401 or 403

### Requirement: Account deletion
Deleting an account SHALL:
- remove its affiliate code, wallet and payout details;
- keep withdrawal and commission rows for accounting. Each withdrawal SHALL keep the email it was requested under, so the admin can still see who was paid;
- never release a held commission of the deleted account into a wallet.

Accounts the deleted account referred SHALL keep `referredByUserId`, and no further commission SHALL accrue to the deleted referrer.

#### Scenario: Deleted referrer
- **WHEN** affiliate A is deleted and a customer A referred pays an order
- **THEN** no commission is recorded
