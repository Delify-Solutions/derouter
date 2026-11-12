## Context

This builds on the shipped `affiliate-program` (archived change `2026-11-05-affiliate-referrals`). Commission accrues inside `approveOrderSync` and lands in a per-currency wallet: `affiliateLedger`, with released and held commissions in `affiliateCommissions`.

Facts from the codebase this design relies on:
- RPM/TPM come from the plan behind the paying purchase (`billing/rates.js` joins `userPlans.planId` → `plans`). A credit-only grant with no plan therefore has no rate cap at all. That is why converted credit is granted against a template plan.
- `grantUserPlan(db, { planId, creditNanoUsd, durationDays, limits, source })` creates one independent purchase per call. Credit grants are not stacked, so each conversion keeps its own expiry.
- Gateway orders are created in `createGatewayOrderSync`, inside the route's transaction. Manual orders go through `billingRepo.createOrder`, then the route sets `payCurrency = 'USD', payAmount = amountNanoUsd`.
- Reconciliation matches a transfer to an order by `paymentCode` and `payAmount`. Lowering `payAmount` before the QR is shown is therefore enough for a discounted order to be matched.

## Goals / Non-Goals

Goals:
- No cash payout.
- Commission spendable only as API credit or as single-use vouchers.
- A bonus for the referred buyer.
- Money stays integer: đồng and nano-USD, with BigInt for the rate maths.

Non-goals:
- Partial voucher use and voucher expiry.
- Converting credit back into the wallet.
- Clawing back granted credit or created vouchers after a refund (the wallet goes negative instead, as today).

## Decisions

### D1. Data (additive; `SCHEMA_VERSION` +1)

New table:

```
affiliateVouchers
  id TEXT PK, code TEXT UNIQUE NOT NULL, ownerUserId TEXT NOT NULL,
  currency TEXT NOT NULL ('VND'|'USD'), amount INTEGER NOT NULL,
  status TEXT NOT NULL ('active'|'used'|'cancelled'),
  heldByOrderId TEXT, usedOrderId TEXT, usedByUserId TEXT, usedAt TEXT,
  cancelledAt TEXT, createdAt TEXT NOT NULL
  indexes: (ownerUserId, createdAt DESC), (status, createdAt DESC)
```

New columns:
- `affiliates`: `buyerBonusBp INTEGER`, `buyerBonusMaxOrders INTEGER` (NULL = default).
- `orders`:
  - `voucherId TEXT`;
  - `voucherDiscount INTEGER` (in the order's pay currency);
  - `referralDiscountBp INTEGER` (unlimited-plan buyer discount).

`affiliateWithdrawals` is removed from `TABLES`. Existing databases keep the empty table; sync never drops it. The `payoutVnd` / `payoutUsd` columns stay unused.

### D2. Spending the wallet

Both conversion and voucher creation go through one helper, `spendSync(db, userId, { currency, amount, kind, meta })`, in `wallet.js`. It:
1. runs `releaseDueSync`;
2. checks the program is enabled and the affiliate is active;
3. parses the amount as a whole number (`toWholeNumber`);
4. checks the minimum (`affiliateMinRedeem*`);
5. checks the available balance;
6. writes the negative ledger row.

The caller adds its own effect in the same transaction:
- **Conversion** (`convertToCreditSync`): `grantUserPlan` with the template plan id, the converted credit, `unlimitedCredit: false`, `durationDays: affiliateCreditDays`, the template plan's limits and `source: 'affiliate'`, plus an audit row.
- **Voucher** (`createVoucherSync`): inserts the voucher row.

VND → nano-USD is `BigInt(vnd) * 1e9n / BigInt(rate)`, floored. Ledger kinds: `convert_credit`, `voucher`, `voucher_cancelled`, `adjust`, `commission`, `reversal`.

### D3. Vouchers at checkout

`applyCheckoutDiscountsSync(db, { userId, plan, payCurrency, payAmount, voucherCode, now, settings })` is a pure pricing step, shared by the gateway path and the manual path. It returns `{ payAmount, voucher, voucherDiscount, referralDiscountBp }` or an error.

Order of discounts:
1. Term discount (existing).
2. Referral discount (unlimited plans only, D4).
3. Voucher.

**Voucher validity.** A voucher is usable when `status = 'active'` and `heldByOrderId` is NULL or points to an order that is not `pending`. The new order then sets `heldByOrderId`.

No hook is needed when an order expires or is cancelled: the hold lapses as soon as the order is no longer pending. Cancelling a voucher (refund to the wallet) additionally requires that NO order with `voucherId = V` is `pending` or `expired` — not just the current holder, which a newer order may have taken over — because an expired order can still be approved late by an admin.

**Approval.** `approveOrderSync` marks the order's voucher used (`usedOrderId`, `usedByUserId`, `usedAt`) when the voucher is still `active`.

Known gap (documented): if an expired order is approved late after its voucher was reused by another paid order, the voucher has been honoured twice. This needs an admin acting on an expired order, and its cost is bounded by the voucher value.

**Zero total.** When the amount to pay reaches 0, the route inserts the order and calls `approveOrderSync(db, id, { approvedBy: 'voucher' })` in the same transaction. A gateway order is then returned already `paid`, and the plans page shows "Đã thanh toán bằng voucher" instead of navigating to the QR page.

**USDT amounts.** When a discount changed a USDT amount, it is rounded UP to a cent (never above the original price), because Binance takes at most 8 decimals.

**Pending orders that never finish.** Manual orders do not expire, and deleting an account does not cancel its pending orders. A voucher held by such an order stays held until an admin cancels the order. Accepted: the admin can see and cancel it.

**Manual orders.** The route wraps `createOrder` with a sync variant inside one transaction so that the voucher hold and the price update cannot be separated: `createOrderSync` is extracted from `createOrder`, then the discounts are applied and payAmount/amountNanoUsd updated.

### D4. Referred-buyer bonus (`src/lib/affiliate/buyerBonus.js`)

`buyerBonusTermsSync(db, buyerId, settings)` returns `{ bp, maxOrders, referrerId }` or null. It returns null when the program is off, the buyer has no referrer, the referrer is missing or blocked, or the bp is 0. The overrides come from `affiliates.buyerBonusBp` / `buyerBonusMaxOrders`.

- **Credit plans:** `grantBuyerBonusSync(db, orderRow, { now })` runs in `approveOrderSync` after the commission. If the buyer's other `paid` orders, plus pending orders that already reserved a referral discount, number fewer than maxOrders (0 = unlimited), it grants `floor(creditNanoUsd × periods × bp / 10000)` against the template plan, with source `referral_bonus`, the order's id and the same lifetime as converted credit. Carrying the order id means `refundOrder` closes the bonus together with the order. No template plan means no grant.
- **Unlimited plans:** the discount is decided at creation. It applies when `paid orders + pending orders with referralDiscountBp > 0` is below maxOrders. Its effect is `payAmount -= floor(payAmount × bp / 10000)`. `amountNanoUsd` is scaled the same way, so revenue stays coherent.

### D5. UI

**Customer `/account/affiliate`:**
- the payout and withdrawal sections are removed;
- "Đổi thành credit" (currency, amount, live preview "≈ $X credit, hết hạn sau 30 ngày, giới hạn theo gói <tên>");
- "Tạo voucher" (currency, amount);
- "Voucher của bạn": code with copy button, value, status, used by (masked), cancel.

**Plans page:** a "Voucher (tùy chọn)" field above the buy buttons, sent as `voucherCode`. An order that comes back `paid` shows a success notice and reloads.

**Order page:** "Giảm giá giới thiệu X%" and "Voucher −Y" lines when present.

**Admin:**
- the settings tab gains the new keys; the template plan is picked from the plan list;
- the CTV modal gains the buyer bonus overrides;
- the "Rút tiền" tab becomes "Voucher" (list + filter);
- the audit labels gain `affiliate_credit_converted`, `affiliate_voucher_created` and `affiliate_voucher_cancelled`.

### D6. Deletion

`deleteUser` cancels the account's `active` vouchers (no refund) and deletes the affiliate row and its ledger rows. Used vouchers and commissions are kept.

## Risks / Trade-offs

- **Rate drift:** the admin rate is a single number, and changing it affects only future conversions and cross-currency voucher use.
- **Template plan edits:** RPM/TPM are read live from the plan, while limits are snapshotted at grant time. This is the same as for any purchase.
- **Self-use:** an affiliate can use its own voucher. That is intended: it is the "spend as discount" path.
