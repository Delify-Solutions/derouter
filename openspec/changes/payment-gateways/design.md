## Context

See `proposal.md` and the four specs. This change is built **after** `openspec/changes/billing-v2-plan-queue` is fully implemented and reuses its conventions — read that change's `design.md` "Context" first (nano-USD integers, synchronous `Sync` functions taking `db`, driver-free modules under `src/lib/billing/` and now `src/lib/payments/`, relative imports in anything a test loads, platform-free admin errors `{ error: "<Vietnamese>" }`, `getAdminActor`, `insertAuditSync`, `ui-dna.md`). It also relies on what that change produced: `orders.limits` snapshots, `grantUserPlan` in `src/lib/billing/grants.js`, the plan queue, `/account/plans` purchase cards, plan `stats`.

Reference implementation studied (read-only copy in `reference/topsubre-php/`, see `reference/README.md`): `github.com/duogxaolin/topsubre-php` (`processing/payment/bank.php`, `pay.php`, `binance.php`, `app/controllers/recharge/*.php`, `app/services/DepositStatusRules.php`). Kept from it: deposit request with a code written in the transfer content/note, polling bank history (web2m) and Binance Pay history, exact-amount match for bank transfers, dedup by the provider's transaction id, row lock while crediting, "late or wrong transfer → note for admin instead of dropping it", dry-run mode, refusing manual status changes that could credit twice. Deliberately not copied:
- wallet top-up: derouter pays each order (`proposal.md`);
- the two-cron flow (`xuly → congtien → hoantat`): one transaction does match + approval here;
- `processTransaction` computing `$id = prefix . parse_order_id(...)` before its null check, so "no code" was never detected — here a missing code is an explicit `no_code` review reason;
- the checksum that silently rewrites itself on mismatch (`pay.php`) — no checksum; idempotency comes from the UNIQUE external id and the order status check under lock;
- bank passwords inside request URLs being loggable — secrets are never logged;
- polling as the only signal — SePay webhooks push instantly, polling is a backstop.

Current derouter facts used here:
- `orders` columns today: `id, userId, planId, amountNanoUsd, creditNanoUsd, durationDays, status, method (default 'manual'), payerNote, adminNote, approvedBy, createdAt, paidAt` (+ `emailSnapshot`, `limits` from the previous change). Statuses in `src/app/api/orders/route.js:7`: `pending, paid, cancelled, refunded`.
- `approveOrder(id, adminId)` in `src/lib/db/repos/billingRepo.js` wraps its work in `db.transaction`; it cannot be called inside another transaction.
- `planPurchaseBlocker` counts orders with `status <> 'cancelled'` for the monthly limit.
- Secret encryption: `encryptSecret`/`decryptSecret`/`isEncrypted` in `src/lib/crypto/secrets.js` (imports `@/lib/dataDir`, so it must stay out of modules loaded by tests; repos call it).
- Telegram: `notifyAdmin(text)` in `src/lib/notify/telegram.js`.
- Background job pattern: `src/lib/billing/expiry.js` (globalThis state, unref'd interval, re-entry guard, swallow errors) started from `src/shared/services/initializeApp.js`.
- Public API allow-list: `PUBLIC_API_PATHS` in `src/dashboardGuard.js`.

## Goals / Non-Goals

**Goals:**
- One reconciliation function (`ingestTransactionSync`) used by the webhook, every poller, the dry run and tests.
- Zero double approvals under retries, concurrent webhook + poll delivery, or admin actions.
- Every received incoming payment visible to the admin with a clear state.

**Non-Goals:**
- Wallet balances, card payments, ACB balance checks or outgoing transfers, outbound refunds, currency conversion, invoices.
- Multiple receiving accounts load-balanced per order (the lowest sort-order active provider of the kind is used).

## Decisions

### D1 — Data model (`src/lib/db/schema.js`, bump `SCHEMA_VERSION` by 1)

| Table | Column | Definition |
|---|---|---|
| `plans` | `priceVnd` | `INTEGER` nullable; đồng; `NULL`/0 = VietQR not offered |
| `orders` | `paymentCode` | `TEXT`; index `CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_paycode ON orders(paymentCode)` (SQLite allows many NULLs for manual orders) |
| `orders` | `payCurrency` | `TEXT` — `USD` (manual), `VND`, `USDT` |
| `orders` | `payAmount` | `INTEGER` — đồng for VND; nano-USDT for USDT; nano-USD for manual |
| `orders` | `paymentProviderId` | `TEXT` |
| `orders` | `expiresAt` | `TEXT` ISO; set for gateway orders only |
| `orders` | `paymentTransactionId` | `TEXT` |
| `orders` | `status` values | add `expired` (TEXT, no schema change; update `STATUSES` in `src/app/api/orders/route.js`) |
| `paymentProviders` (new) | `id TEXT PK`, `kind TEXT NOT NULL` (`sepay`/`web2m`/`acb`/`binance`), `name TEXT NOT NULL`, `isActive INTEGER DEFAULT 1`, `sortOrder INTEGER DEFAULT 0`, `config TEXT` (JSON, non-secret), `secrets TEXT` (JSON whose values are `encryptSecret` output), `pollIntervalSeconds INTEGER DEFAULT 30`, `lastPolledAt TEXT`, `lastError TEXT`, `createdAt TEXT`, `updatedAt TEXT`; index `(kind, isActive, sortOrder)` |
| `paymentTransactions` (new) | `id TEXT PK`, `providerId TEXT NOT NULL`, `kind TEXT NOT NULL`, `externalId TEXT NOT NULL`, `amount INTEGER NOT NULL`, `currency TEXT NOT NULL`, `content TEXT`, `occurredAt TEXT`, `receivedAt TEXT NOT NULL`, `via TEXT` (`webhook`/`poll`), `raw TEXT`, `status TEXT NOT NULL` (`matched`/`needs_review`/`resolved`), `reason TEXT`, `orderId TEXT`, `resolvedBy TEXT`, `resolvedAt TEXT`, `resolutionNote TEXT`; indexes `CREATE UNIQUE INDEX ... ON paymentTransactions(providerId, externalId)`, `(status, receivedAt DESC)`, `(orderId)` |

`config` shapes: sepay `{ bankBin, bankName, accountNumber, accountName }`; web2m `{ bankBin, bankName, accountNumber, accountName, apiBase, urlStyle: "token" | "password_account_token" }`; acb `{ bankBin: "970416", bankName: "ACB", accountNumber, accountName, clientId?, appApiKey?, deviceId?, appVersion? }` (identity overrides; when absent use env `ACB_CLIENT_ID`, `ACB_API_KEY`, `ACB_DEVICE_ID`, `ACB_APP_VERSION`, else the defaults found in `reference/topsubre-php/processing/payment/acb-lib.php`'s constructor); binance `{ payUid, accountName, qrImageUrl }`. `secrets` keys: sepay `{ webhookKey, apiToken? }`; web2m `{ token, password? }`; acb `{ username, password, proxyUrl? }`; binance `{ apiKey, apiSecret }`.

ACB token cache: the `kv` table (`src/lib/db/helpers/kvStore.js`), scope `payments:acb-token`, key = provider id, value = `encryptSecret(JSON { token, fingerprint, savedAt })` with `fingerprint = sha256(username|password|deviceId|baseUrl)`; a cached token whose fingerprint differs from the current credentials is ignored and overwritten.

Settings (stored in the settings JSON, defaults in `DEFAULT_SETTINGS` of `settingsRepo.js`): `paymentCodePrefix: "DR"`, `paymentOrderTtlMinutes: 30`, `allowManualOrders: true`.

### D2 — Modules (driver-free, relative imports, synchronous where they touch the DB)

| Module | Exports |
|---|---|
| `src/lib/payments/amounts.js` | `parseDecimalToNano(str)` (exact decimal string → integer ×1e9, no floats; rejects exponents), `formatVnd(int)` → `250.000đ`, `formatUsdt(nano)` |
| `src/lib/payments/codes.js` | `CODE_ALPHABET`, `generatePaymentCode(prefix)`, `isValidPrefix(p)`, `extractCandidateCodes(content, prefix)` → ordered unique list (raw upper-cased text first, then the alphanumeric-only text; regex `PREFIX[ALPHABET]{8}`) |
| `src/lib/payments/providers/sepay.js` | `verifyWebhookAuth(header, webhookKey)` (constant-time via `crypto.timingSafeEqual` on equal-length buffers), `normalizeSepayTransaction(payload)` → normalized tx, `fetchSepayTransactions({ config, secrets, fetchImpl, now })` |
| `src/lib/payments/providers/web2m.js` | `buildWeb2mUrl({ config, secrets })`, `normalizeWeb2mTransaction(item)`, `fetchWeb2mTransactions({ config, secrets, fetchImpl })` |
| `src/lib/payments/providers/acb.js` | `buildAcbHeaders({ identity, token, appVersion })`, `isTokenExpiredResponse(body)`, `isForbiddenServiceResponse(body)`, `extractMemo(description)`, `parseNotification(notification)` → `{ direction, amount }`, `normalizeAcbHistoryRow(row)`, `normalizeAcbNotification(n, accountNumber)`, `fetchAcbTransactions({ config, secrets, fetchImpl, now, tokenStore })` where `tokenStore = { get(), set(token), clear() }` is injected (the poller passes the kv-backed store; tests pass an in-memory one) |
| `src/lib/payments/providers/binance.js` | `signQuery(query, secret)` (hex HMAC-SHA256), `normalizeBinanceTransaction(item)`, `fetchBinanceTransactions({ config, secrets, fetchImpl, now, lookbackDays = 3 })` |
| `src/lib/payments/reconcile.js` | `ingestTransactionSync(db, { provider, tx, via, nowIso, dryRun })` → `{ outcome: "duplicate" \| "matched" \| "needs_review" \| "ignored", reason?, orderId? }`; `resolveTransactionSync(db, { transactionId, action: "assign" \| "resolve", orderId?, reason, actor, nowIso })` |
| `src/lib/payments/checkout.js` | `offeredMethodsSync(db, plan, settings)`, `createGatewayOrderSync(db, { userId, plan, method, settings, nowIso })`, `expireGatewayOrdersSync(db, nowIso)` |
| `src/lib/billing/orders.js` | `approveOrderSync(db, orderId, { approvedBy, now, paymentTransactionId = null, allowExpired = false })` — the body of today's `approveOrder` moved out of its `db.transaction`; `billingRepo.approveOrder` becomes `db.transaction(() => approveOrderSync(...))` |

Every `fetch*` function takes `fetchImpl` (default global `fetch`) so tests inject responses, applies a 15 s `AbortSignal.timeout`, returns `{ ok: true, transactions }` or `{ ok: false, error }` where `error` never contains the URL, headers or secrets (map to messages like `"web2m: HTTP 502"`, `"web2m: hết thời gian chờ"`, `"binance: chữ ký bị từ chối (code -1022)"`).

Repos (may import the driver and `secrets.js`): `src/lib/db/repos/paymentProvidersRepo.js` (CRUD; encrypt on write; `getProviderWithSecrets(id)` decrypts for internal use only; `toPublicProvider(row)` returns `secretsSet: { key: { set, last4 } }`), `src/lib/db/repos/paymentTransactionsRepo.js` (list with filters/pagination, count needing review).

### D3 — Normalized transaction
`{ externalId: string, direction: "in" | "out", amount: integer, currency: "VND" | "USDT", content: string, occurredAt: ISO | null, raw: object }`.
- **SePay** (webhook body and API rows; field names to be confirmed against the SePay docs when implementing): `externalId = String(id)`, `direction = transferType === "in" ? "in" : "out"`, `amount = transferAmount` (integer đồng), `content = content || description`, `occurredAt` from `transactionDate` (`YYYY-MM-DD HH:mm:ss`, Asia/Ho_Chi_Minh → ISO UTC). Webhook payloads whose `accountNumber` differs from the provider's account number are stored as `needs_review` with reason `wrong_provider`.
- **web2m** (as consumed by topsubre `bank.php`): response `{ transactions: [...] }`; per item `externalId = transactionID` with spaces removed, `direction = type === "IN" ? "in" : "out"`, `amount = integer of amount`, `content = description`, `occurredAt` from `transactionDate` when present. URL: style `token` → `${apiBase}/${token}`; style `password_account_token` → `${apiBase}/${password}/${accountNumber}/${token}`.
- **ACB** (D10): history rows → `externalId = (id || transactionNumber || transactionID)` with spaces removed, `direction = type === "IN" ? "in" : "out"`, `amount = Math.round(Math.abs(amount))`, `content = extractMemo(description)`, `occurredAt` from `postingDate`/`transactionDate` (ms); notification rows → `externalId = "n:" + id`, direction and amount from `parseNotification`, `content = extractMemo(message || title)`, `occurredAt` from `createdAt` (ms). The `n:` prefix keeps a notification and a later history row of the same transfer from being two different ids only when ACB reuses ids; when they differ, the order-status check under lock (D4) still prevents a second approval and the extra row becomes `needs_review/order_not_pending`.
- **Binance Pay** (`GET https://api.binance.com/sapi/v1/pay/transactions`, header `X-MBX-APIKEY`, query `timestamp`, `recvWindow=10000`, `startTime`, `endTime`, `limit=100`, `signature`): response `data` array; `externalId = transactionId`, `direction = Number(amount) > 0 ? "in" : "out"`, currency must be `USDT` (or a `fundsDetail` entry in USDT, as topsubre does) else `ignored`, `amount = parseDecimalToNano(amount)`, `content = note`, `occurredAt` from `transactionTime` (ms).

### D4 — Reconciliation algorithm (`ingestTransactionSync`), inside one `db.transaction`
1. `direction !== "in"` → `ignored` (not stored).
2. `INSERT` into `paymentTransactions` with status `needs_review` placeholder; on UNIQUE conflict → `duplicate` (return; nothing else). In `dryRun`, check existence with a SELECT instead and never write.
3. Extract candidates (`extractCandidateCodes(content, settings.paymentCodePrefix)`); look up orders by `paymentCode IN (...)`; none → `needs_review/no_code` if no candidate, `order_not_found` if candidates but no order.
4. Order checks in this order: `paymentProviderId !== provider.id` → `wrong_provider`; status `paid`/`refunded`/`cancelled` → `order_not_pending`; status `expired` or `occurredAt > expiresAt` → `order_expired`; `occurredAt < createdAt − 5 min` → `order_not_found` (stale reuse of a code is impossible since codes are unique, so this only protects against clock skew abuse); currency mismatch → `wrong_provider`; VND `amount !== payAmount` → `amount_mismatch`; USDT `amount < payAmount` → `underpaid`.
5. All pass → `approveOrderSync(db, order.id, { approvedBy: "payment:" + provider.kind, paymentTransactionId: tx.id, now })`; set transaction `matched`, `orderId`.
6. After commit (outside the transaction) the caller sends `notifyAdmin` for `matched` and `needs_review` (never for `duplicate`/`ignored`), fire-and-forget.

`resolveTransactionSync`: only from `needs_review`; `assign` → order must be `pending` or `expired` → `approveOrderSync(..., { approvedBy: actor, allowExpired: true })`, transaction `matched` with `resolvedBy/resolvedAt/resolutionNote`; `resolve` → transaction `resolved`. Both write `insertAuditSync` on the order owner (`payment_assigned` / `payment_resolved`) when an order is involved. Reason 3–500 chars.

`approveOrderSync` refuses unless status is `pending` (or `expired` with `allowExpired`), so a second approval is impossible even if two deliveries race; SQLite serializes writers, and the status check happens inside the write transaction.

### D5 — Checkout
- `offeredMethodsSync`: per spec `plan-dual-pricing`, reading active providers ordered by `sortOrder, createdAt`.
- `createGatewayOrderSync`: checks the method, `planPurchaseBlocker` rules (monthly limit now excludes `cancelled` and `expired`), pending gateway orders < 5, generates a unique code (retry up to 8 times on collision), snapshots plan credit/duration/limits like `createOrder`, sets `amountNanoUsd` = plan USD price (unchanged meaning), `payCurrency`/`payAmount`, `paymentProviderId`, `expiresAt`, `method`.
- `POST /api/account/orders` dispatches: `manual` → existing `createOrder` (only if `allowManualOrders`, sets `payCurrency = "USD"`, `payAmount = amountNanoUsd`); `vietqr`/`binance` → `createGatewayOrderSync`.
- `GET /api/account/orders/[id]` (new): owner-only; returns order fields plus `payment`: for VietQR `{ bankName, bankBin, accountNumber, accountName, amount, content: paymentCode, qrUrl }`; for Binance `{ payUid, accountName, qrImageUrl, amountUsdt (string), note: paymentCode }`.
- VietQR image: `https://img.vietqr.io/image/${bankBin}-${accountNumber}-compact2.png?amount=${amount}&addInfo=${paymentCode}&accountName=${encodeURIComponent(accountName)}` (public VietQR quick-link; confirm the format when implementing). The page always shows the copyable fields too, so a failed image never blocks payment.

### D6 — Background jobs (`src/lib/payments/poller.js`, async, started in `initializeApp.js` next to the billing janitor)
Same shape as `src/lib/billing/expiry.js` (globalThis state, `DISABLE_PAYMENT_POLLER` env, skip during `next build`). Tick every 15 s:
1. `expireGatewayOrdersSync(db, now)`;
2. for each active provider due (`lastPolledAt + pollIntervalSeconds ≤ now`, interval clamped to ≥ 15, ≥ 30 for `acb`) and not already in flight: decrypt secrets, call its `fetch*`, then for each transaction `ingestTransactionSync(db, { ..., via: "poll" })`; store `lastPolledAt` and `lastError` (`null` on success). SePay is polled only when `apiToken` is set.
Each provider runs independently; one failure never stops the others.

### D7 — Webhook route `src/app/api/payments/sepay/webhook/route.js`
Add `"/api/payments/sepay/webhook"` to `PUBLIC_API_PATHS` in `src/dashboardGuard.js`. Handler: read `Authorization`; find the active `sepay` provider whose decrypted `webhookKey` verifies; none → 401 `{ success: false }`. Parse JSON (bad JSON → 400). Normalize, `ingestTransactionSync(..., via: "webhook")`, notify, answer 200 `{ success: true }`. Body larger than 64 KB → 413.

### D8 — Admin APIs (admin JWT, `getAdminActor`)
- `GET|POST /api/payments/providers`, `GET|PATCH|DELETE /api/payments/providers/[id]` (secrets write-only; empty secret field in PATCH keeps the stored value; `regenerateWebhookKey: true` issues a new 32-byte base64url key and returns it once), `POST /api/payments/providers/[id]/test` (dry run → `{ results: [{ externalId, amount, currency, content, outcome, reason, orderId }] }`).
- `GET /api/payments/transactions?status&providerId&from&to&page` → `{ transactions, total, needsReviewCount }`; `POST /api/payments/transactions/[id]/resolve` `{ action, orderId?, reason }`.
- Settings: `paymentCodePrefix`, `paymentOrderTtlMinutes`, `allowManualOrders` validated in `src/app/api/settings/route.js` PATCH.

### D9 — UI
- `/dashboard/payments` (`src/app/(dashboard)/dashboard/payments/page.js` + `PaymentsPageClient.js`): tabs "Nguồn nhận tiền" and "Giao dịch"; provider form per kind (D1 fields), SePay webhook URL/key copy box, "Chạy thử" result table, transactions table with filters, raw-payload `Drawer`, resolve modal with required reason; sidebar entry "Thanh toán" with a needs-review count badge (`src/shared/components/Sidebar.js`).
- `/account/orders/[id]` (`src/app/account/orders/[id]/page.js` + `OrderPaymentClient.js`): spec `payment-checkout` "Order page"; countdown with `aria-live="polite"` announcements only on status change (not every second).
- `/account/plans` purchase card: one button per offered method ("Chuyển khoản VietQR · 250.000đ", "Binance USDT · $10", "Thủ công") → POST → navigate to the order page.
- Plan form: "Giá VND (VietQR)" integer input; landing/purchase cards show both prices.
All per `openspec/ui-dna.md`.

### D10 — ACB mobile-app client (port of `reference/topsubre-php/processing/payment/acb-lib.php`)
- Base URL `https://apiapp.acb.com.vn` (env `ACB_BASE_URL` overrides for tests). Routes: login `POST /mb/v2/auth/tokens`; history `GET /mb/legacy/ss/cs/person/transaction-history/list?account=<no>&transactionType=ALL&from=<ms>&to=<ms>&min=&max=`; notifications `GET /mb/legacy/ss/cs/bankservice/v2/notifications?page=0&size=<n>&language=en` (sent with app version `3.52.0`, as the reference does). Balance, recipient lookup and transfers are not ported.
- Headers on every call: `Content-Type: application/json; charset=utf-8`, `User-Agent: ACB-MBA/9 CFNetwork/1399 Darwin/22.1.0`, `Accept: application/json, text/plain, */*`, `Accept-Language: vi`, `Cache-Control: no-cache`, `apikey: <appApiKey>`, `x-app-version: <appVersion>`, `x-device-id: <deviceId>`, `x-conversation-id: <uuid v4>-1-`, `x-request-id: <uuid v4>`, plus `Authorization: bearer <token>` when logged in.
- Login body `{ clientId, username, password, deviceId }`; success = response has `accessToken`; failure message from `error`/`message`, prefixed "Đăng nhập ACB thất bại".
- Token handling: read `tokenStore.get()`; none → login and `set`. Call history; if `isTokenExpiredResponse` (body has key `exp`, or `message === "Unauthorized"`, or HTTP 401 with a non-JSON body) and the token was cached → `clear()`, login once, retry once; still expired → error "Token ACB bị từ chối sau khi đăng nhập lại".
- Range: last 30 days, at most 100 rows, newest first.
- Fallback: when history `data` is empty or `isForbiddenServiceResponse` (`message === "You cannot consume this service"`), call notifications; success = `codeStatus === 200` with array `data`; keep notifications whose JSON contains the account number digits (if none contain it, keep all, as the reference does); `parseNotification`: direction `out` when the text matches `(VND) -` or contains `ghi nợ`/`debit`, else `in`; amount from the `amount` field or from `(VND) [+-] <digits with , or .>`.
- `extractMemo`: text after the first case-insensitive `transaction:`, trimmed of spaces and `*`.
- Proxy: optional `secrets.proxyUrl` (`http://user:pass@host:port`) applied with `undici`'s `ProxyAgent` as the fetch `dispatcher`; TLS verification is never disabled (the reference's `ACB_INSECURE_SSL` is not ported).
- Errors never include the username, password, token or proxy credentials.

## Risks / Trade-offs

- [ACB app API is unofficial: endpoints/headers can change, ACB can lock the login or require OTP for a new device] → isolated in one module with fixtures; poll interval ≥ 30 s; admin warning on the form; recommend a dedicated receiving account; errors surface on the provider row; SePay/web2m remain available as alternatives.

- [Provider API/webhook field names differ from the assumed ones] → normalizers isolated per provider with fixture tests; verify against current SePay, web2m and Binance docs during implementation; the dry run shows normalized output before going live.
- [Customer mistypes the code] → transaction kept as `needs_review/no_code`; admin assigns it; the order page warns about exact content.
- [Webhook and poll deliver the same transaction concurrently] → UNIQUE (providerId, externalId) plus status check inside the write transaction; second delivery is `duplicate`.
- [USDT price drift vs USD] → accepted: 1 USDT = 1 USD by decision; overpayment approves, underpayment goes to review.
- [Late payment after expiry] → review + "Gán vào đơn", never lost.
- [Secrets leaking through errors/logs] → fetchers return sanitized errors; tests assert no secret substring in errors.
- [VietQR image service unavailable] → copyable fields always shown.

## Migration Plan

1. Implement after `billing-v2-plan-queue` is merged and deployed.
2. Deploy with no provider configured: behavior is unchanged (only manual orders offered).
3. Admin sets `priceVnd` on plans, creates a SePay provider, sets the webhook in SePay, uses "Chạy thử", then enables it; same for web2m/Binance.
4. Rollback: disable providers (orders fall back to manual); the schema additions are additive and harmless.

## Open Questions

- Exact current field names of the SePay webhook/API and the web2m response for the operator's bank — confirm from their docs/accounts during implementation; only the normalizers depend on them.
