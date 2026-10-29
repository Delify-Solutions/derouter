## Why

After `billing-v2-plan-queue`, a customer still buys a plan by creating a pending order that an admin approves by hand after checking the bank. That does not scale and makes customers wait. The operator already runs automatic deposits in another product (`topsubre-php`: bank via web2m, Binance Pay USDT) and wants the same, plus SePay, for derouter — paying each order directly instead of topping up a wallet, with prices the admin sets per plan in VND (VietQR) and in USD (Binance).

## What Changes

Phase GĐ5, built on top of `billing-v2-plan-queue` (requires its GĐ0–GĐ4 to be complete).

- Each plan gets two admin-set prices: `priceVnd` (VietQR, integer đồng) and the existing USD price (Binance, paid in USDT at 1 USDT = 1 USD). A payment method is offered only when its price is set (> 0) and an active receiving provider of that kind exists. No exchange rate is involved.
- **Pay-per-order checkout**: choosing a plan and a method creates an order carrying a unique payment code, the exact amount and currency to pay, the receiving provider and an expiry (default 30 minutes). The order page shows the QR (VietQR image, or the admin's Binance QR/UID), copyable payment fields, a countdown, and updates itself when paid.
- **Four receiving providers**:
  - `sepay` — webhook push (`POST /api/payments/sepay/webhook`, `Authorization: Apikey <key>`) plus optional polling of the SePay transactions API to catch missed webhooks;
  - `web2m` — polling of the web2m bank-history API (token-based URL, secrets never logged);
  - `acb` — polling of an ACB account directly through the ACB mobile-app API (`apiapp.acb.com.vn`, the "local" bank mode of topsubre-php): login with the account's internet-banking username/password, cached bearer token re-issued once on expiry, transaction history with the notifications feed as fallback when history is blocked, optional HTTP proxy;
  - `binance` — polling of Binance Pay transaction history (`GET /sapi/v1/pay/transactions`, HMAC-SHA256 signed), matched on the payment code written in the transfer note.
- **One reconciliation path** for all providers: every incoming transaction is stored once (deduplicated by provider + external id), its payment code is extracted, and the order is approved automatically when the amount matches (VND: exact; USDT: at least the requested amount). Everything else — no code, unknown/expired/already-paid order, wrong amount — is kept as "cần kiểm tra" for the admin. Approval reuses the existing grant path (limits snapshot, queue, debt paydown).
- Pending gateway orders expire automatically (new order status `expired`); a late payment becomes "cần kiểm tra" and the admin can assign it to the order, which approves it.
- **Admin**: `/dashboard/payments` with provider configuration (secrets encrypted at rest, webhook URL and key shown for SePay, dry-run "Chạy thử" per provider) and a transactions list with filters, raw payload, "Gán vào đơn" and "Đánh dấu đã xử lý" actions (reason required, audited). Telegram notification on every automatic approval and every transaction needing review.
- Plan form gains the VND price; landing and purchase cards show both prices; plan revenue statistics are reported per currency.
- Manual orders (admin approval, no gateway) stay available behind a setting `allowManualOrders` (default on) as a fallback.
- The original PHP payment files are stored read-only under `reference/topsubre-php/` (see `reference/README.md`) as the porting reference.
- Out of scope: wallet top-up/balance, card/scratch-card payments, ACB balance checks and transfers (only incoming history is read), refunds to the payer's bank/Binance account, automatic currency conversion.

## Capabilities

### New Capabilities
- `plan-dual-pricing`: VND and USD prices per plan, which payment methods a plan offers, display and per-currency revenue.
- `payment-checkout`: creating a gateway order, payment code, amount snapshot, order page, status polling, cancel, expiry, pending-order limits.
- `payment-reconciliation`: receiving transactions from SePay (webhook and polling), web2m, ACB (mobile-app API) and Binance Pay, deduplication, code extraction, matching rules, automatic approval, review states, admin resolution.
- `payment-provider-admin`: admin configuration of receiving providers, secret handling, dry run, transactions list and notifications.

### Modified Capabilities
<!-- `billing-v2-plan-queue` is not archived yet, so its capabilities are not in openspec/specs/; the plan-template revenue statistic and the order status list it defines are extended here as new requirements of `plan-dual-pricing` and `payment-checkout`. -->

## Impact

- **Code**: new `src/lib/payments/` (codes, providers/{sepay,web2m,acb,binance}, reconcile, checkout), new `src/lib/billing/orders.js` (`approveOrderSync` extracted from `billingRepo.approveOrder`), new repos `paymentProvidersRepo.js` and `paymentTransactionsRepo.js`, new poller started from `src/shared/services/initializeApp.js`, routes under `src/app/api/payments/**` and `src/app/api/account/orders/**`, `src/dashboardGuard.js` (public webhook path), plan form, `/account/plans` purchase flow, new `/account/orders/[id]` page, new `/dashboard/payments` page, landing price display, `src/lib/notify/telegram.js`.
- **Database**: `plans.priceVnd`; `orders.paymentCode` (unique), `orders.payCurrency`, `orders.payAmount`, `orders.paymentProviderId`, `orders.expiresAt`, `orders.paymentTransactionId`; new tables `paymentProviders`, `paymentTransactions`; order status `expired`; `SCHEMA_VERSION` bump.
- **Public surface**: one new unauthenticated endpoint (the SePay webhook) protected by a per-provider API key.
- **External services**: SePay, web2m, ACB mobile-app API (unofficial, may change or lock the account — see design risks), Binance API (outbound HTTPS with timeouts); VietQR quick-link image service for QR rendering.
- **Dependencies**: none new.
