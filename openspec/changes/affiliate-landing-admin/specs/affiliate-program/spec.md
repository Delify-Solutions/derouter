## MODIFIED Requirements

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

## ADDED Requirements

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

