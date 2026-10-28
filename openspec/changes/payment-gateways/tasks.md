## 1. Preparation

- [ ] 1.1 Confirm `openspec/changes/billing-v2-plan-queue` is fully implemented (its tasks all checked, `npm test`/`npm run lint`/`npm run build` green). Read its `design.md` "Context", this change's `design.md`, `openspec/ui-dna.md`, and the Next.js 16 guides in `node_modules/next/dist/docs/01-app/` for route handlers and dynamic pages.
- [ ] 1.2 Work on a feature branch (`git switch -c feat/payment-gateways`); commit only when the user asks; never push to `main` (it deploys production).
- [ ] 1.3 Before writing the provider normalizers, check the current public docs of SePay (webhook body, auth header, transactions API) and of the web2m API in use, and the Binance Pay `GET /sapi/v1/pay/transactions` response; if a field name differs from design D3, follow the docs and update D3 in this change. For ACB there are no public docs: the behavior to port is `reference/topsubre-php/processing/payment/acb-lib.php` (design D10) — read it fully before writing `acb.js`.

## 2. Schema and settings

- [ ] 2.1 `src/lib/db/schema.js`: add `plans.priceVnd`, the six `orders` columns and the unique `idx_orders_paycode` index, tables `paymentProviders` and `paymentTransactions` with their indexes (design D1); bump `SCHEMA_VERSION` by 1.
- [ ] 2.2 `src/lib/db/repos/settingsRepo.js` `DEFAULT_SETTINGS`: `paymentCodePrefix: "DR"`, `paymentOrderTtlMinutes: 30`, `allowManualOrders: true`; `src/app/api/settings/route.js` PATCH validates them (prefix 2–6 uppercase letters, TTL 10–1440 integer, boolean) with HTTP 400.
- [ ] 2.3 Add `expired` to `STATUSES` in `src/app/api/orders/route.js` and to every status label map in the admin and customer order UIs; `planPurchaseBlocker` (`billingRepo.js`) counts orders with status not in (`cancelled`, `expired`). ← (verify: a fresh DATA_DIR boots; existing tests green)

## 3. Pure payment helpers (relative imports only, with tests)

- [ ] 3.1 `src/lib/payments/amounts.js` per design D2 + `test/payment-amounts.test.js` (`"10"` → 10e9, `"10.5"` → 10.5e9, `"0.00000001"` → 10, rejects `"1e3"`, `"abc"`, negatives; `formatVnd(250000)` → `250.000đ`).
- [ ] 3.2 `src/lib/payments/codes.js` per D2 + `test/payment-codes.test.js` (code shape and alphabet; `extractCandidateCodes` on `MBVCB.1234567.DR8K3Q7MZP.CT tu 0123`, on `dr8k 3q7m zp thanh toan`, on text without a code, and with a custom prefix).
- [ ] 3.3 `src/lib/payments/providers/sepay.js`, `web2m.js`, `binance.js` per D2/D3 with injected `fetchImpl`, 15 s timeout and sanitized errors + `test/payment-providers.test.js` using JSON fixtures: normalization of in/out rows for each provider, web2m URL for both styles, Binance `signQuery` against a known HMAC vector, a non-USDT Binance row ignored, `verifyWebhookAuth` accepts the right key and rejects wrong/missing/different-length keys, and no error string contains a token, password, key or secret. ← (verify: every normalizer has fixture coverage for an incoming and an outgoing transaction)
- [ ] 3.4 `src/lib/payments/providers/acb.js` per design D10 (relative imports; `undici` `ProxyAgent` only when `proxyUrl` is set) + `test/payment-acb.test.js` with an injected `fetchImpl` and in-memory `tokenStore`: headers present and token sent as `bearer`; no login when a token is cached; expired token (`exp` key, `"Unauthorized"`, bare 401) → one re-login and one retry, second refusal → error; forbidden history → notifications fallback with account filtering; `parseNotification` for `(VND) + 250,000`, `(VND) - 50.000`, `ghi nợ`; `extractMemo` for `... transaction: DR8K3Q7MZP chuyen tien*`; history row normalization; errors never contain the username, password, token or proxy credentials. ← (verify: every scenario of the "ACB account polling" requirement in specs/payment-reconciliation)

## 4. Order approval refactor

- [ ] 4.1 Create `src/lib/billing/orders.js` with `approveOrderSync(db, orderId, { approvedBy, now, paymentTransactionId, allowExpired })` containing today's `approveOrder` body (status `pending`, or `expired` when allowed; marks `paid`, `paidAt`, `approvedBy`, `paymentTransactionId`; grants with the order snapshot); `billingRepo.approveOrder` calls it inside `db.transaction`. Existing approval tests stay green.

## 5. Checkout

- [ ] 5.1 `src/lib/payments/checkout.js`: `offeredMethodsSync`, `createGatewayOrderSync`, `expireGatewayOrdersSync` per design D5 and spec `payment-checkout`.
- [ ] 5.2 `src/app/api/account/orders/route.js` POST accepts `{ planId, method }` and dispatches (manual only when `allowManualOrders`; manual orders get `payCurrency "USD"` and `payAmount = amountNanoUsd`); errors: 400 not offered / blocked, 429 more than 5 pending gateway orders.
- [ ] 5.3 Create `src/app/api/account/orders/[id]/route.js` GET (owner only, 404 otherwise) returning the order and the `payment` block of design D5, keeping the existing cancel behavior in the same folder working.
- [ ] 5.4 `src/app/api/account/plans/route.js`: each catalog plan carries `priceVnd`, `offeredMethods` and display strings.
- [ ] 5.5 Add `test/payment-checkout.test.js`: method offered/not offered, code uniqueness, amounts and currencies snapshotted, `expiresAt` from the TTL setting, 6th pending order refused, expiry job sets `expired`, expired orders not counted by the monthly limit. ← (verify: every scenario of specs/payment-checkout except the page UI)

## 6. Reconciliation

- [ ] 6.1 `src/lib/payments/reconcile.js`: `ingestTransactionSync` (design D4, steps 1–5, `dryRun` writes nothing) and `resolveTransactionSync` (assign / resolve with reason, audit entries `payment_assigned` / `payment_resolved`).
- [ ] 6.2 Add `test/payment-reconcile.test.js` covering: exact VND match approves and queues the plan; duplicate delivery changes nothing; outgoing ignored; `no_code`, `order_not_found`, `wrong_provider`, `order_not_pending` (already paid), `order_expired` (status expired and paid after `expiresAt`), `amount_mismatch`, Binance overpay approves, Binance `underpaid`; dry run leaves DB unchanged; `assign` approves an expired order once and a second assign is refused; `resolve` requires a reason. ← (verify: every scenario of specs/payment-reconciliation; no path approves an order twice)

## 7. Repos, webhook and poller

- [ ] 7.1 `src/lib/db/repos/paymentProvidersRepo.js` (encrypt secrets with `encryptSecret`, `getProviderWithSecrets`, `toPublicProvider` exposing only `{ set, last4 }`, delete refused with 409 when orders or transactions reference it) and `src/lib/db/repos/paymentTransactionsRepo.js` (filtered paginated list joined to orders and users, `countNeedsReview`).
- [ ] 7.2 Create `src/app/api/payments/sepay/webhook/route.js` per design D7 and add `"/api/payments/sepay/webhook"` to `PUBLIC_API_PATHS` in `src/dashboardGuard.js`; 401 on bad key, 400 on bad JSON, 413 above 64 KB, 200 `{ success: true }` otherwise; admin notification after commit.
- [ ] 7.3 Create `src/lib/payments/poller.js` per design D6 (for `acb`, pass a `tokenStore` backed by the `kv` table scope `payments:acb-token` with `encryptSecret`/`decryptSecret` and the credential fingerprint of design D1; changing an ACB provider's username, password or identity in 7.1 clears that entry) and start it from `src/shared/services/initializeApp.js` next to the billing janitor (respect `DISABLE_PAYMENT_POLLER` and the build phase).
- [ ] 7.4 `src/lib/notify/telegram.js`: add `notifyPaymentMatched({ email, planName, amountText, providerName, orderId })` and `notifyPaymentNeedsReview({ amountText, content, reason, providerName })`, both fire-and-forget. ← (verify: with a local server, a curl POST with a valid SePay-style body and key approves a pending order; a wrong key gets 401; repeating the POST changes nothing)

## 8. Admin

- [ ] 8.1 Create `src/app/api/payments/providers/route.js`, `[id]/route.js`, `[id]/test/route.js` and `src/app/api/payments/transactions/route.js`, `[id]/resolve/route.js` per design D8 (admin actor via `getAdminActor`).
- [ ] 8.2 Create `/dashboard/payments` (`page.js` + `PaymentsPageClient.js`) per design D9: provider list/form per kind (including `acb` with its warning text from spec `payment-provider-admin`), secrets write-only with "đã lưu (…last4)", SePay webhook URL + key copy box and regenerate, "Chạy thử" results table, transactions tab with filters, raw payload drawer, resolve modal with required reason; Sidebar item "Thanh toán" with the needs-review badge.
- [ ] 8.3 Plan form (`src/app/(dashboard)/dashboard/plans/PlansPageClient.js`): add "Giá VND (VietQR)", relabel the USD price "Giá USD (Binance)"; plan list shows `revenueVnd` and `revenueUsdNano` (update the stats query from `billing-v2-plan-queue` task 10.6 to split revenue by `payCurrency`, treating `USD` and `USDT` as USD). ← (verify: every scenario of specs/payment-provider-admin and the revenue scenario of specs/plan-dual-pricing)

## 9. Customer pages and landing

- [ ] 9.1 `/account/plans` purchase cards: one button per offered method with its price ("Chuyển khoản VietQR · 250.000đ", "Binance USDT · $10", "Thủ công"); on success navigate to `/account/orders/<id>`; the orders list links each gateway order to its page and shows `expired`.
- [ ] 9.2 Create `/account/orders/[id]` (`page.js` + `OrderPaymentClient.js`) per spec `payment-checkout` "Order page": VietQR image + copy fields, Binance QR/UID + copy fields, instructions, countdown, 5-second status polling, success / expired / cancelled states, "Huỷ đơn" and "Tạo đơn mới", not-found state for other users' orders, keyboard and screen-reader friendly per `openspec/ui-dna.md`.
- [ ] 9.3 Landing plan cards (`src/app/landing/components/PlansSection.js`, `salesData.js`) show the price of each offered method (`250.000đ`, `$10`) or "Chưa mở bán". ← (verify: every scenario of specs/plan-dual-pricing and the UI scenarios of specs/payment-checkout)

## 10. Release gate and end-to-end check

- [ ] 10.1 `npm test`, `npm run lint`, `npm run build` pass.
- [ ] 10.2 **Operator step — stop and hand back.** With a real SePay account (or SePay's webhook test tool): set `priceVnd` on a plan, create the SePay provider, register the webhook URL and key in SePay, run "Chạy thử", place a small real order, transfer with the shown content, and confirm the order turns `paid` within seconds and the plan appears in the queue; repeat a wrong-amount transfer and resolve it from "Giao dịch". Do the same for Binance with a small USDT amount if used. ← (verify: whole change end to end against all four specs)
