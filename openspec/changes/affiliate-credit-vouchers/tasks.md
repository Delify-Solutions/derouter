## 1. Data and settings

- [x] 1.1 Schema:
  - add the `affiliateVouchers` table;
  - add `affiliates.buyerBonusBp` and `affiliates.buyerBonusMaxOrders`;
  - add `orders.voucherId`, `orders.voucherDiscount` and `orders.referralDiscountBp`;
  - remove `affiliateWithdrawals` from `TABLES`;
  - bump `SCHEMA_VERSION`.
- [x] 1.2 `affiliate/settings.js`: add the new keys with defaults and ranges, drop the withdraw minimums, and validate the template plan id in `PATCH /api/settings`.

## 2. Wallet spending

- [x] 2.1 `wallet.js`:
  - remove payout and withdrawals;
  - add `spendSync`, `convertToCreditSync` and the "spent" figure in `walletSync`.

  ← (verify: VND rate maths in BigInt; each conversion creates its own grant with template limits and N-day expiry)
- [x] 2.2 `vouchers.js`: `createVoucherSync`, `cancelVoucherSync`, `findUsableVoucherSync`, `markVoucherUsedSync`, `applyCheckoutDiscountsSync`.
- [x] 2.3 `buyerBonus.js`: `buyerBonusTermsSync`, `grantBuyerBonusSync`, `referralDiscountFor`.

## 3. Checkout and approval

- [x] 3.1 `checkout.js`: apply the discounts, record them on the order, hold the voucher, and approve immediately when the total is 0.
- [x] 3.2 Manual path: `createOrderSync` plus discounts in one transaction.
- [x] 3.3 `approveOrderSync`: mark the voucher used and grant the buyer bonus.

  ← (verify: the voucher is held and released correctly; a zero-total order is paid at once; commission is computed on the discounted amount; the bonus goes to the first N orders only)

## 4. APIs

- [x] 4.1 Customer:
  - `POST /api/account/affiliate/convert`;
  - `GET/POST /api/account/affiliate/vouchers` and `DELETE /api/account/affiliate/vouchers/[id]`;
  - remove the payout and withdrawals routes;
  - `/api/account/orders` accepts `voucherCode`.
- [x] 4.2 Admin: `GET /api/affiliates/vouchers`; remove the withdrawal routes; the PATCH accepts the buyer bonus overrides.

## 5. UI

- [x] 5.1 Customer affiliate page (convert, voucher, voucher list); plans page voucher field; order page discount lines; register banner bonus text.
- [x] 5.2 Admin page: settings fields, CTV modal overrides, Voucher tab, audit labels.

## 6. Deletion, docs, tests

- [x] 6.1 `deleteUser`: cancel active vouchers; drop the withdrawal handling.
- [x] 6.2 Update `content/docs/gioi-thieu.md`.
- [x] 6.3 Tests for every new scenario; update the affiliate tests for the removed withdrawals; run `npm test`, lint and build.

  ← (verify: the full suite passes)
