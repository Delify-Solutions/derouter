## Context

Billing facts this change builds on (read the files before coding):

- **Orders** (`orders` table) become `paid` in exactly one function: `approveOrderSync(db, orderId, …)` in `src/lib/billing/orders.js`.
  - It is called by the payment reconciler (`src/lib/payments/reconcile.js`, two call sites) and by the admin approval (`billingRepo.approveOrder`).
  - It is synchronous and runs inside the caller's `db.transaction`.
  - It returns `alreadyApproved: true` for a repeat.
  - `orders.js` is driver-free: relative imports only, never import `../db/driver.js` or a repo that does.
- **Refunds** run in `billingRepo.refundOrder`, one `db.transaction`.
- **Order amounts**:
  - `amountNanoUsd` is the USD list price.
  - `payCurrency` is `VND` / `USDT` / `USD` / NULL.
  - `payAmount` is đồng for VND, nano-USDT for USDT, nano-USD for USD.
  - Revenue code (`planStats`) already buckets `VND` vs everything else, falling back to `amountNanoUsd` when `payAmount` is NULL. Use the same rule.
- **New-user gift codes** (`giftCodes.newUserOnly = 1`) already enforce: linked Telegram, no prior purchase, one new-user code per Telegram user (`giftRepo.newUserRefusalSync`). This change reuses that rule unchanged.
- **Registration** is `POST /api/public/register` → `createUser(...)` in `userRepo.js`. The register page is `src/app/register/page.js` (server) with `components/RegisterForm.js` (client).
- **Middleware**: `src/dashboardGuard.js` lists public pages in `PUBLIC_PAGE_PATHS`. `/api/*` outside `PUBLIC_API_PATHS` and `/api/account` requires the admin JWT. `/api/account/*` requires the customer session (`resolveAccountUser`).
- **Settings** are one JSON blob with defaults in `settingsRepo.DEFAULT_SETTINGS`. They are saved through `PATCH /api/settings`.
- **Audit**: `insertAuditSync(db, {userId, actor, action, reason, details})` in `src/lib/billing/audit.js`. Admin identity comes from `getAdminIdentity()`.
- **Telegram**: notifications use `notifyAdmin(text)` in `src/lib/notify/telegram.js`.

## Goals / Non-Goals

**Goals**
- Every customer can refer when the program is enabled.
- The admin sets a default rate and a default first-N, with per-affiliate overrides for CTV deals.
- Commission is exact, idempotent and atomic with order approval and refund.
- The commission wallet is per currency, with manual withdrawals.
- The referral link advertises a Telegram-verified welcome gift code.

**Non-Goals**
- Converting commission into API credit (a possible follow-up; it needs a VND→credit rate decision).
- Automatic bank or crypto payouts.
- Multi-level commission.
- Attributing existing accounts through a link.
- Fraud scoring. Admins get visibility (shared-IP hint) and the block switch instead.

## Decisions

### D1. Data model (additive; bump `SCHEMA_VERSION` by one over `main`)

`main` is at 25 today and open PR #35 moves it to 26. Use the next free number at implementation time.

New columns on `users`:

```
referredByUserId TEXT   -- affiliate (referrer) user id; NULL = not referred
referredAt       TEXT
```

Add index `idx_users_referred ON users(referredByUserId) WHERE referredByUserId IS NOT NULL`.

New tables:

```
affiliates
  userId TEXT PRIMARY KEY          -- the account (one row per account that has a code)
  code TEXT UNIQUE NOT NULL        -- stored uppercase
  rateBp INTEGER                   -- NULL = default
  maxOrders INTEGER                -- NULL = default; 0 = unlimited
  giftCodeId TEXT                  -- NULL = default
  status TEXT NOT NULL DEFAULT 'active'   -- 'active' | 'blocked'
  clickCount INTEGER DEFAULT 0
  payoutVnd TEXT                   -- JSON {bankName, accountNumber, accountName}
  payoutUsd TEXT                   -- JSON {network, address}
  adminNote TEXT
  createdAt TEXT, updatedAt TEXT

affiliateCommissions
  id TEXT PRIMARY KEY
  orderId TEXT UNIQUE NOT NULL     -- idempotency: one commission per order
  affiliateUserId TEXT NOT NULL
  referredUserId TEXT NOT NULL
  currency TEXT NOT NULL           -- 'VND' | 'USD'
  baseAmount INTEGER NOT NULL      -- đồng or nano-USD
  rateBp INTEGER NOT NULL
  amount INTEGER NOT NULL
  status TEXT NOT NULL             -- 'pending' | 'available' | 'reversed'
  availableAt TEXT NOT NULL        -- accrual + holdDays
  releasedAt TEXT, reversedAt TEXT
  createdAt TEXT NOT NULL
  indexes: (affiliateUserId, status, availableAt), (referredUserId, status)

affiliateLedger                    -- append-only; balance = SUM(delta) per (userId, currency)
  id INTEGER PRIMARY KEY AUTOINCREMENT
  userId TEXT NOT NULL
  currency TEXT NOT NULL
  delta INTEGER NOT NULL
  kind TEXT NOT NULL               -- 'commission' | 'reversal' | 'withdrawal' | 'withdrawal_rejected' | 'adjust'
  commissionId TEXT, withdrawalId TEXT
  meta TEXT                        -- JSON, e.g. {reason, admin}
  createdAt TEXT NOT NULL
  indexes: (userId, currency), (userId, createdAt DESC)

affiliateWithdrawals
  id TEXT PRIMARY KEY
  userId TEXT NOT NULL
  emailSnapshot TEXT
  currency TEXT NOT NULL
  amount INTEGER NOT NULL
  destination TEXT NOT NULL        -- JSON snapshot of payout details at request time
  status TEXT NOT NULL             -- 'pending' | 'paid' | 'rejected'
  txRef TEXT, adminNote TEXT, decidedBy TEXT, decidedAt TEXT
  createdAt TEXT NOT NULL
  indexes: (status, createdAt), (userId, createdAt DESC)
```

Why a ledger plus a status column, instead of only summing commissions:
- Withdrawals, rejections, reversals after release and admin adjustments all move the balance. One append-only ledger proves the balance the same way `creditLedger` does for API credit.
- Commission status alone is what the UI needs for "pending" vs "available".

Only **released** commission writes a ledger row. Pending money is read from `affiliateCommissions`.

Why `referredByUserId` lives on `users` and not on `affiliates`: the referrer belongs to the *referred* account, which may never become an affiliate itself, and it is read on every order approval.

### D2. Accrual inside `approveOrderSync`

Add `accrueCommissionSync(db, orderRow, { now })` in `src/lib/affiliate/commission.js` (driver-free, relative imports). Call it from `approveOrderSync` right after the grant, only on the non-`alreadyApproved` path, and return the result as `commission` in the approval result.

Because every approval path goes through this one function inside its transaction:
- an approval and its commission commit or roll back together;
- the reconciler and the admin path cannot diverge;
- `orderId UNIQUE` makes a repeat a no-op. Use `INSERT … ON CONFLICT(orderId) DO NOTHING` or check first; both are safe because the adapter is synchronous.

Settings are needed inside a sync function. `approveOrderSync` cannot `await getSettings()`, so the commission module reads the settings blob synchronously from the same `db`. Read how `settingsRepo` stores it and add a small sync reader (`readAffiliateSettingsSync(db)`) that merges the affiliate defaults. Do not import `settingsRepo` (it resolves the adapter).

Algorithm:

1. `buyer = SELECT id, referredByUserId FROM users WHERE id = order.userId`. Stop if there is no referrer, or the referrer is the buyer.
2. Read the settings. Stop if `affiliateEnabled` is not true.
3. `aff = SELECT * FROM affiliates WHERE userId = referrer`. Stop if it is missing or blocked, or if the referrer's `users` row is missing (deleted).
4. Compute the effective `rateBp` and `maxOrders` (override ?? default).
5. If `maxOrders > 0` and `COUNT(*) FROM orders WHERE userId = buyer AND status = 'paid' AND id != this order` ≥ `maxOrders`, stop. This rule is "the first N paid orders", counted over orders rather than commissions: an order paid while the program was off, while the referrer was blocked or before an admin set the referrer still uses its place (owner decision after review). A refunded order has status `refunded` and frees its place.
6. Work out the base amount and currency:
   - `currency = order.payCurrency === 'VND' ? 'VND' : 'USD'`;
   - `base = VND ? payAmount : (payAmount ?? amountNanoUsd)`.

   USDT is nano-USDT, treated 1:1 as nano-USD, the same as revenue stats. The commission is `Math.floor(base * rateBp / 10000)`. Use BigInt for the multiplication: nano-USD × 10000 can exceed 2^53 for orders over ~$900k. Stop if it is ≤ 0.
7. Insert the commission with `status = holdDays === 0 ? 'available' : 'pending'` and `availableAt = now + holdDays`. If it is available immediately, insert the `commission` ledger row in the same step (set `releasedAt`).

### D3. Lazy release, no poller

`releaseDueSync(db, userId, now)` sets `status = 'available'` and `releasedAt` on every pending commission with `availableAt <= now`, and inserts one `commission` ledger row per released commission. Run it inside the write transaction of:
- every wallet read (`GET /api/account/affiliate`, the admin affiliate detail);
- every withdrawal request.

Admin lists that sum balances across many affiliates call a bulk variant, `releaseAllDueSync(db, now)`, first. This keeps the system single-process friendly and needs no new scheduler. Balances are always correct at the moment they are read.

### D4. Reversal inside `refundOrder`

Inside `refundOrder`'s transaction, call `reverseCommissionForOrderSync(db, orderId, { now, actor })`:
- `pending` → `reversed`;
- `available` → `reversed`, plus a `reversal` ledger row of `-amount`;
- already reversed or missing → no-op.

Write an audit row on the affiliate's account (`affiliate_commission_reversed`).

### D5. Withdrawals

All in `affiliateRepo`, inside one `db.transaction`:

**Request**:
1. `releaseDueSync`.
2. Check: not blocked; payout details present; `amount` is an integer ≥ the minimum; `amount` ≤ balance; no pending withdrawal in that currency.
3. Insert the withdrawal with a snapshot of `destination`.
4. Insert a `withdrawal` ledger row of `-amount`.

The synchronous transaction makes the "two requests at once" case safe.

**Admin decision**:
- The status guard is `WHERE id = ? AND status = 'pending'`. 0 changes → 409.
- `paid` stores `txRef`.
- `rejected` inserts `withdrawal_rejected` of `+amount`.
- Both write an audit row on the affiliate's account.

Notify the admin on Telegram after commit: amount, currency, and the masked destination (last 4 digits only). Telegram is a third-party channel, so it never receives the full account number.

### D6. Codes, links and cookie

- **Code**: 6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` via `crypto.randomInt`. Retry on a UNIQUE conflict up to 5 times, then fall back to 8 characters.
- **Created lazily**: `ensureAffiliateSync(db, userId)` is called by `GET /api/account/affiliate` when the program is enabled. Accounts that never open the page have no row.
- **`/r/[code]`**: a route handler (`src/app/r/[code]/route.js`, GET).
  - Normalise to uppercase, then look up the affiliate.
  - If the code is valid (program enabled, affiliate active, account exists):
    - set the cookie `dr_ref` (path `/`, httpOnly, sameSite lax, secure when the request is https, maxAge `affiliateCookieDays` × 86400);
    - bump `clickCount` unless the incoming `dr_ref` already equals the code;
    - 302 to `/register?ref=CODE` with a RELATIVE `Location`. In a route handler `request.url` carries the server's listen address (`0.0.0.0:20127` in Docker), so an absolute redirect built from it is unreachable. `Secure` is decided from the public origin (`getPublicOrigin`), not from `request.url`.
  - Otherwise 302 to `/register`.
  - Add `"/r"` to `PUBLIC_PAGE_PATHS` in `dashboardGuard.js`.
  - Rate-limit click counting per IP with `checkLimits` (60/hour/IP). The redirect still happens when the limit is hit; only the count is skipped.
- **Register API**:
  - `resolveFirstReferralSync(db, [body.ref, cookie dr_ref])` returns the first VALID code and its referrer. The register page calls it with `[?ref=, cookie]`, so the banner and the binding always agree.
  - Pass `referredByUserId` into `createUser`, which writes it in the same INSERT.
  - Clear the cookie on the response (`maxAge 0`).
  - The response body is unchanged.
- **Register page**:
  - `page.js` (server) reads `searchParams.ref` or `cookies().get('dr_ref')`.
  - It resolves the referral and its eligible gift code server-side, and passes `{ referral: { code, giftCode|null } }` to `RegisterForm`.
  - `RegisterForm` shows the banner and sends `ref`.
  - Do not add a public lookup API: doing it server-side avoids a code-enumeration endpoint.

### D7. Welcome gift

**Eligible gift** for a referrer: the effective `giftCodeId` (override ?? `affiliateDefaultGiftCodeId`) whose row:
- exists;
- has `newUserOnly = 1` and `isActive = 1`;
- is inside its start/expiry window;
- has `redeemedCount < maxRedemptions`.

Reuse giftRepo's `inWindow` logic by exporting it, not by copying it.

**Validation on save** (settings PATCH and the affiliate PATCH): the id must be empty or a `newUserOnly = 1` code → else 400 "Chỉ chọn được mã người mới (bắt buộc liên kết Telegram)".

**Where the code is shown**:
- `GET /api/account/affiliate/gift` returns `{ code }` for the logged-in account when it has a referrer, an eligible gift exists, and the account has not redeemed that gift.
- `/account/gift` calls it, shows a callout "Quà giới thiệu" with the code, and prefills `GiftRedeemForm`'s initial value. Add an `initialCode` prop.
- The existing Telegram-link flow on `telegram_required` handles verification. Do not touch the redeem rules.

### D8. API surface

Customer, under the `/api/account` session:

- `GET /api/account/affiliate`:
  - `{ enabled, code, link, rateBp, maxOrders, giftCode, stats {clicks, signups, payingReferrals}, wallet {VND:{available,pending,earned,withdrawn}, USD:{…}}, payout {vnd, usd}, minWithdraw {VND, USD} }`;
  - `link` is built from `publicBaseUrl` (the same helper registration mail uses) and the request origin.
- `PUT /api/account/affiliate/payout`: `{ currency, … }`.
- `GET /api/account/affiliate/commissions?limit&offset`: masked buyer email, order amount and currency, status, dates.
- `GET /api/account/affiliate/referrals?limit&offset`: masked email, signup date, earned per currency.
- `GET|POST /api/account/affiliate/withdrawals`.
- `GET /api/account/affiliate/gift`.

Admin, behind the admin JWT by default because they are not public:

- `GET /api/affiliates?q&status&limit&offset`: list with aggregates.
- `GET|PATCH /api/affiliates/[userId]`:
  - the PATCH accepts `rateBp|null`, `maxOrders|null`, `giftCodeId|null`, `status`, `adminNote`;
  - every write is audited.
- `POST /api/affiliates/[userId]/adjust`: `{ currency, delta, reason }`. The reason is required and `delta` ≠ 0.
- `GET /api/affiliates/commissions?affiliateUserId&status`.
- `GET /api/affiliates/withdrawals?status` and `PATCH /api/affiliates/withdrawals/[id]` with `{ action: 'paid'|'rejected', txRef?, reason? }`.
- `PATCH /api/users/[id]/referrer` with `{ referrerUserId|null, reason }`:
  - refuse self-referral;
  - refuse a referrer that does not exist;
  - create the referrer's `affiliates` row when it has none (accrual needs it);
  - this does NOT create commission retroactively.
- Settings keys go through the existing `PATCH /api/settings`. Add range validation for the new keys there.

Email masking: keep the first 2 characters of the local part, then `***@domain`. Put it in one helper (`src/lib/affiliate/mask.js`) with tests.

### D9. UI

Follow `openspec/ui-dna.md`: square, 1px borders, mono numbers, no colour-only status. All text is Vietnamese.

**Customer** (`/account/affiliate`, nav item "Giới thiệu", icon `group_add`, shown only when enabled or the account has wallet history):
- the link, with a copy button (`CopyBlock`);
- the terms sentence;
- the gift code, if any;
- three stat tiles;
- the wallet table per currency;
- payout forms;
- the withdraw form;
- the withdrawal and commission tables.

**Admin** (`/dashboard/affiliates`, sidebar "Affiliate", icon `group_add`), with four tabs: Cài đặt, CTV, Hoa hồng, Rút tiền.
- The rate is entered as a percent with up to 2 decimals and converted to bp; no float storage.
- The gift-code picker lists only new-user codes.

**Admin user detail page**: a "Người giới thiệu" field with set/clear (reason required), plus a link to the account's affiliate row.

Money formatting:
- VND uses the existing đồng formatter;
- USD uses `fmtUsdNano`.

### D10. Account deletion (`userRepo.deleteUser`)

Inside the existing transaction:
- delete the `affiliates` row and the `affiliateLedger` rows for the user;
- set `emailSnapshot` on the user's `affiliateWithdrawals` (they are kept);
- keep `affiliateCommissions`. Release (D3) skips rows whose affiliate account no longer exists, so a held commission is never paid into a deleted wallet.

Referred accounts keep `referredByUserId`. Accrual stops because step 3 of D2 needs the referrer's `users` row.

## Risks / Trade-offs

- **Self-farming**: an affiliate can register throwaway accounts through their own link and buy plans. Each purchase is real money and the commission is below 100%, so the effect is a discount, not a loss.
  - Mitigations: the hold period, refund reversal, first-N, and the block switch.
  - The admin list shows a "trùng IP" hint when a referral shares any `activityLog.ip` with its affiliate (one indexed query per page row, limited to the visible page).
- **Negative balances after a refund post-payout**: accepted by design. The money is recovered from future commission, and withdrawals are blocked meanwhile.
- **Two currencies**: there is no FX, so an affiliate may hold small balances in both. This is accepted; the admin can adjust with a reason.
- **Settings in a sync path**: the sync settings reader must use the same storage key and default merge as `settingsRepo`, or the two will disagree. Cover it with a test that saves through `updateSettings` and reads through the sync reader.
- **Schema number collision** with PR #35/#36: resolve at implementation time by rebasing on `main`.

## Migration Plan

- Everything is additive and auto-synced by `TABLES`. The `SCHEMA_VERSION` bump triggers the pre-migration backup. No versioned migration is needed.
- The program ships disabled (`affiliateEnabled = false`), so deploying changes nothing until the admin turns it on.
- Rollback: turn off `affiliateEnabled`. The new tables and columns are inert.

## Open Questions

None blocking. The owner chose:
- a commission wallet with withdrawal;
- N counted per referred customer;
- a default gift code plus a per-CTV gift code;
- every customer can refer, behind an admin on/off switch.
