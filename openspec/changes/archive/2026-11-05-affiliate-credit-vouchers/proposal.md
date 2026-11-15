## Why

The owner does not want to pay commission out in cash. Commission should only be spent inside the service: as API credit for the affiliate, or as purchase vouchers the affiliate hands to anyone. The owner also wants the referred customer rewarded, not only the referrer, so the link is worth clicking.

## What Changes

- **BREAKING (unshipped):** withdrawals are removed — the payout details, the withdrawal request, the admin decision and the Telegram withdrawal notice. The commission wallet stays: per-currency balances (VND, USD) from released commission, minus reversals.
- **Convert to credit.** An affiliate converts any amount of its wallet (at least the admin minimum) into API credit.
  - VND converts at the admin rate `affiliateVndPerUsd` (đồng per $1 of credit); USD converts 1:1.
  - Each conversion is its own purchase-like grant: it is never merged with an earlier one, and it expires `affiliateCreditDays` (default 30) after it is made.
  - The grant takes RPM, TPM and the per-window limits of a plan the admin picks as the template (`affiliateCreditPlanId`).
- **Vouchers.** An affiliate turns any amount of its wallet into a single-use voucher code, which it can give to anyone.
  - A customer enters the code when buying a plan; its value comes off the order price, converted at the admin rate when the order is paid in the other currency. Any unused remainder is lost.
  - An order brought to 0 is approved immediately, with no payment.
  - The affiliate can cancel an unused voucher and get its value back.
- **Referred-buyer bonus.** A referred customer's first N paid orders (default N, per-CTV override) each earn X% (default X, per-CTV override):
  - for a plan with a credit amount: X% of the order's credit, as a separate grant with the template plan's limits and `affiliateCreditDays` expiry;
  - for an unlimited plan: X% off the price at checkout.
- **Admin page:**
  - Settings gain the rate, the template plan, the credit lifetime, the minimum per conversion/voucher and the buyer bonus.
  - The CTV dialog gains the buyer bonus overrides.
  - The withdrawals tab is replaced by a vouchers tab.
- **Customer page:** the payout and withdrawal sections are replaced by "Đổi thành credit", "Tạo voucher" and a voucher list.
- **Checkout:**
  - The plans page gains a voucher field.
  - Orders record the voucher and the referral discount they used.
  - The order page shows the discounts.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `affiliate-program`: withdrawals removed; wallet spending through credit conversion and vouchers; referred-buyer bonus; settings, customer page, admin page and account deletion updated.

## Impact

- **Database** (additive, `SCHEMA_VERSION` +1):
  - new table `affiliateVouchers`;
  - `affiliates.buyerBonusBp` and `affiliates.buyerBonusMaxOrders`;
  - `orders.voucherId`, `orders.voucherDiscount` and `orders.referralDiscountBp`.
  - `affiliateWithdrawals` and the payout columns stay in existing databases, unused. The feature never shipped enabled, so nothing to migrate.
- **Code:**
  - `src/lib/affiliate/*`: wallet, new `vouchers.js`, new `buyerBonus.js`, settings;
  - `src/lib/payments/checkout.js` and the manual-order path in `/api/account/orders`;
  - `src/lib/billing/orders.js` (`approveOrderSync`);
  - affiliate APIs and UIs, plans page, order page, `userRepo.deleteUser`.
- **Settings:**
  - new: `affiliateVndPerUsd`, `affiliateCreditPlanId`, `affiliateCreditDays`, `affiliateMinRedeemVnd`, `affiliateMinRedeemUsdNano`, `affiliateBuyerBonusBp`, `affiliateBuyerBonusMaxOrders`;
  - removed: `affiliateMinWithdrawVnd`, `affiliateMinWithdrawUsdNano`.
