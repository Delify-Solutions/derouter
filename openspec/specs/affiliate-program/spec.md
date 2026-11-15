# affiliate-program Specification

## Purpose
Lets customers and collaborators (CTV) refer new buyers through a personal link, earn a configurable commission on the first orders those buyers pay, and withdraw it. The link can also advertise a Telegram-verified welcome gift code.
## Requirements
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

### Requirement: One referral code per account
A customer SHALL get a referral code the first time the customer opens the affiliate page while the program is enabled and the access mode admits the account (always in `open` mode; in `invite` mode only an invited account, whose code is created when the admin invites it). An account the access mode does not admit SHALL NOT get a code by opening the page.

The code SHALL be:
- 6–10 characters from an unambiguous uppercase alphabet (no `0`, `O`, `1`, `I`, `L`);
- generated with a cryptographic RNG;
- unique across accounts;
- unchanged for the life of the account.

The referral link SHALL be `<public base URL>/r/<CODE>`. Codes SHALL be matched case-insensitively.

#### Scenario: Code is stable
- **WHEN** a customer opens `/account/affiliate` twice
- **THEN** both visits show the same code and link

#### Scenario: No code for an uninvited account
- **WHEN** `affiliateAccess` is `invite` and a customer without an invitation opens `/account/affiliate`
- **THEN** no code is created and no link is shown

### Requirement: Referral link redirect
`GET /r/<CODE>` SHALL be public. Its behaviour depends on the code:

- **Valid code**: the program is enabled and the code belongs to a non-blocked affiliate that the access mode admits (any affiliate in `open` mode, only an invited one in `invite` mode; see "Affiliate access mode").
  - It SHALL set the cookie `dr_ref=<CODE>` (`HttpOnly`, `SameSite=Lax`, `Secure` on HTTPS, Max-Age = `affiliateCookieDays`).
  - It SHALL redirect (302) to the landing page `/`, where the referral benefits popup is shown. The `Location` SHALL be relative, so it does not depend on the server's listen address.
  - It SHALL increment the affiliate's click counter, at most once per browser: no increment when the request already carries `dr_ref` with the same code.
  - A newer valid link SHALL replace an older cookie (last click wins).
- **Any other code**: it SHALL redirect to `/register` without setting a cookie or counting a click.

#### Scenario: Valid link
- **WHEN** a visitor without cookies opens `/r/k7q2mz` for an active affiliate whose code is `K7Q2MZ`
- **THEN** the response is 302 to `/`, sets `dr_ref=K7Q2MZ`, and the affiliate's clicks go up by one

#### Scenario: Repeat click not counted
- **WHEN** the same visitor opens the link again with `dr_ref=K7Q2MZ` already set
- **THEN** the click counter is unchanged

#### Scenario: Blocked affiliate
- **WHEN** the affiliate is blocked
- **THEN** the response redirects to `/register` and sets no cookie

#### Scenario: Uninvited affiliate in invite mode
- **WHEN** `affiliateAccess` is `invite` and the affiliate has no invitation
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

### Requirement: Referral benefits popup
On the landing page and the docs pages, a visitor who is not signed in SHALL see a popup listing the invitation's benefits when all of these hold:
- the visitor carries a `dr_ref` cookie;
- the code is valid (program on, affiliate not blocked).

The benefits SHALL be computed on the server from the referrer's effective terms:
- with a buyer bonus X > 0:
  - "Tặng thêm X% credit cho N đơn đầu đã thanh toán." (or "mọi đơn đã thanh toán" when N = 0);
  - "Gói không giới hạn credit: giảm X% ngay khi thanh toán.";
- with an eligible welcome gift code: "Mã quà chào mừng <CODE>: liên kết Telegram rồi nhập ở trang Mã quà tặng."

The popup content depends on whether the promo popup is live:
- **Promo live**: its title, body, code and button text SHALL be kept. The benefits SHALL be listed after the body and before the code and the button.
- **Otherwise**: the popup SHALL use the title "Bạn được mời dùng thử" and the button "Đăng ký nhận ưu đãi".

When the referral gives nothing (no buyer bonus and no eligible welcome gift), the referral SHALL be ignored: the promo popup shows unchanged when live, otherwise no popup shows.

The popup SHALL open after at most 1 second. It SHALL follow the promo popup's close and repeat rules. Its content version SHALL include the referral code and the benefits, so arriving through a link shows it again to a visitor who had closed the plain promo.

The button SHALL lead to `/register?ref=<CODE>`. When a gift code is shown, the link SHALL carry `next=/account/gift?code=<GIFT>`, and following it SHALL remember that gift code as the promo hand-off does.

The referral part SHALL NOT be shown in these places:
- `/register`, whose banner already lists the benefits;
- the account area;
- to a signed-in customer.

#### Scenario: Link with a live promo
- **WHEN** a visitor opens a valid referral link whose CTV gives 10% for 1 order while the promo popup is live with code WELCOME
- **THEN** the landing page shows one popup with the promo's title and code and the referral benefits, and its button leads to `/register?ref=<CODE>&next=…WELCOME`

#### Scenario: Link without a promo
- **WHEN** the promo popup is off and the visitor arrives through a valid referral link
- **THEN** the landing page shows "Bạn được mời dùng thử" with the benefits

#### Scenario: Signed-in customer
- **WHEN** a signed-in customer opens the landing page with a `dr_ref` cookie
- **THEN** no referral benefits are shown

#### Scenario: Referral without benefits
- **WHEN** the buyer bonus is 0, the CTV has no welcome gift, and the promo popup is off
- **THEN** a visitor arriving through the link sees no popup

### Requirement: Admin commission actions
In the "Hoa hồng" tab of `/dashboard/affiliates`, an admin SHALL be able to act on one commission through `PATCH /api/affiliates/commissions/<id>` with `{ action, reason }`:

- **`release` ("Duyệt ngay")**: allowed only for a `pending` commission whose affiliate account still exists. It SHALL:
  - set the commission `available` now, with `releasedAt`, and move `availableAt` back to now when it was later;
  - write exactly one `commission` ledger row, the same as the automatic release at the end of the hold, which SHALL then add nothing;
  - write the audit action `affiliate_commission_released` on the affiliate.

  The reason is optional; when given it SHALL be 3–500 characters.
- **`reverse` ("Hủy")**: allowed for a `pending` or `available` commission. A reason of 3–500 characters is required.
  - It SHALL set the commission `reversed`, exactly like a refund's reversal. The order stays paid, so it still counts toward the buyer's first N.
  - An `available` commission SHALL be debited back with one negative `reversal` ledger row. The balance may go negative.
  - It SHALL write the audit action `affiliate_commission_reversed` with the reason on the affiliate.

Responses for actions that cannot apply:
- an unknown id SHALL return 404;
- `release` of a commission that is not pending, or whose affiliate account was deleted, SHALL return 409;
- `reverse` of a reversed commission SHALL return 409;
- a missing or invalid reason where one is required, or an unknown action, SHALL return 400.

The confirmation dialog SHALL state the effect on the CTV's balance.

#### Scenario: Release early
- **WHEN** an admin releases a commission held until next week
- **THEN** it becomes available now, the CTV's balance rises by its amount, and the end of the hold adds nothing more

#### Scenario: Cancel an available commission
- **WHEN** an admin cancels an available 25,000đ commission with reason "tự giới thiệu"
- **THEN** it becomes reversed, the CTV's balance drops by 25,000đ, and the audit log shows the reason

#### Scenario: Cancel without a reason
- **WHEN** an admin cancels a commission with an empty reason or one shorter than 3 characters
- **THEN** the response is HTTP 400 and nothing changes

### Requirement: Admin referral list
`/dashboard/affiliates` SHALL have a "Người được giới thiệu" tab backed by `GET /api/affiliates/referrals?q&affiliateUserId&limit&offset`. It SHALL list every account that has a referrer, newest attachment first, with:
- the account email and status;
- the referrer's email and code;
- the signup date and the attachment date;
- the number of paid orders;
- the held and the available commission per currency that the current referrer earned from the account (cancelled excluded; an earlier referrer's amounts are not counted).

The search SHALL match the account email, the referrer email or the referrer code, with `%` and `_` taken literally. A CTV row SHALL link to this tab filtered to that CTV. Each row SHALL offer "Gỡ giới thiệu", which needs a reason and calls the referrer API (`PATCH /api/users/<id>/referrer` with `referrerUserId: null`).

Removing a referrer SHALL stop later orders from earning commission or buyer bonus for that CTV, and SHALL leave the commissions already recorded unchanged.

#### Scenario: List by CTV
- **WHEN** an admin clicks "Người được giới thiệu" on CTV A's row
- **THEN** the tab lists only the accounts referred by A, with their paid orders and commission

#### Scenario: Remove a referrer
- **WHEN** an admin removes the referrer of account B with a reason
- **THEN** B disappears from the list, the change is audited as `referrer_changed`, and B's existing commissions stay as they were

### Requirement: Affiliate access mode
The admin SHALL choose who may refer new users with the setting `affiliateAccess`: `open` (default; every customer gets a referral link when opening "Giới thiệu") or `invite` (only affiliates the admin invited). The admin SHALL add an invited affiliate by email or user id, which creates its code when missing, and SHALL be able to withdraw or restore an invitation per affiliate. Each invitation change SHALL be audited on the affiliate's account.

In `invite` mode, a referral code of an affiliate without an invitation SHALL be treated as invalid for new users: the redirect, the register banner, registration and the visitor popup SHALL ignore it. What the affiliate already has SHALL be kept: its wallet remains spendable, and accounts it referred before keep earning it commission and keep their buyer bonus. Opening "Giới thiệu" SHALL NOT create a code for an uninvited account, and the item SHALL be hidden unless the account has wallet history or referred users.

#### Scenario: Uninvited link in invite mode
- **WHEN** the mode is `invite` and a visitor opens `/r/<CODE>` of an affiliate without an invitation
- **THEN** no referral cookie is set and the account the visitor creates has no referrer

#### Scenario: Invited affiliate
- **WHEN** the admin adds `ctv@example.com` from "Thêm CTV" while the mode is `invite`
- **THEN** that account gets a code, its link records new users, and the audit shows "Mời làm CTV"

#### Scenario: Existing referral keeps earning
- **WHEN** the mode changes to `invite` and a user referred earlier by an uninvited affiliate pays an order
- **THEN** the commission accrues to that affiliate as before

#### Scenario: Uninvited customer opens the account area
- **WHEN** the mode is `invite` and a customer with no invitation, no wallet history and no referred users signs in
- **THEN** "Giới thiệu" is not in the menu and no affiliate row is created for the account

#### Scenario: Withdrawn invitation
- **WHEN** the admin sets an invited affiliate to "Chưa mời" in invite mode
- **THEN** its link stops recording new users and its wallet stays spendable
