## 0. Before starting

- [x] 0.1 Branch from up-to-date `main` (`feat/affiliate-referrals`). Never push to `main`. Read `CLAUDE.md`, `openspec/ui-dna.md`, then design.md D1–D10. Check the current `SCHEMA_VERSION` on `main` and use the next number.

## 1. Data

- [x] 1.1 `src/lib/db/schema.js`:
  - add `users.referredByUserId`, `users.referredAt` and the partial index `idx_users_referred`;
  - add the tables `affiliates`, `affiliateCommissions` (`orderId UNIQUE`), `affiliateLedger` and `affiliateWithdrawals`, with the indexes in design D1;
  - bump `SCHEMA_VERSION`.
- [x] 1.2 `settingsRepo.DEFAULT_SETTINGS`: add the eight `affiliate*` keys with the defaults from the spec "Program settings".
- [x] 1.3 `src/lib/affiliate/settings.js`:
  - `readAffiliateSettingsSync(db)`: read `settings.data` id=1 and merge the affiliate defaults, the same way `settingsRepo` does;
  - `validateAffiliateSettings(patch)` with the ranges from the spec;
  - wire the validator into `PATCH /api/settings`, which answers 400 on a bad value.

  ← (verify: a value saved through `updateSettings` is read back identically by the sync reader; an out-of-range rate is rejected and the stored value is unchanged)

## 2. Core affiliate logic (driver-free, relative imports only)

- [x] 2.1 `src/lib/affiliate/codes.js`: `generateReferralCode()` (crypto, unambiguous alphabet, 6 chars); `normalizeReferralCode()`.
- [x] 2.2 `src/lib/affiliate/mask.js`: `maskEmail()`.
- [x] 2.3 `src/lib/affiliate/core.js` (sync, `db` first):
  - `ensureAffiliateSync`, with a retry on a code conflict;
  - `resolveReferrerSync(db, code)`: valid only if the program is enabled, the affiliate is active and the user exists;
  - `effectiveTermsSync(db, affiliateRow, settings)`: rate, maxOrders and giftCodeId, each override ?? default.
- [x] 2.4 `src/lib/affiliate/commission.js`:
  - `accrueCommissionSync(db, orderRow, {now})`: implements design D2 steps 1–7 exactly, with BigInt math and `orderId` idempotency;
  - `releaseDueSync(db, userId, now)` and `releaseAllDueSync(db, now)` (D3);
  - `reverseCommissionForOrderSync(db, orderId, {now, actor})` (D4).

  ← (verify: first-N counts the buyer's other PAID orders (owner decision, see 8.2); the currency/base rule matches `planStats`; floor in integer math; no float anywhere)
- [x] 2.5 Call `accrueCommissionSync` from `approveOrderSync` (`src/lib/billing/orders.js`):
  - only on the path that actually marks the order paid;
  - return it as `commission` on the result.

  Call `reverseCommissionForOrderSync` inside `billingRepo.refundOrder`'s transaction, and write an audit row on the affiliate account.

  ← (verify: the gateway path via `reconcile.js`, the admin approve path and the late-expired approve path all accrue exactly once; a refund reverses it; a repeat approval does not duplicate it)
- [x] 2.6 Wallet and withdrawals in `src/lib/affiliate/wallet.js`, all sync:
  - `walletSync(db, userId, now)`: releases due commission first, then returns available / pending / earned / withdrawn per currency;
  - `requestWithdrawalSync` (D5 checks, snapshot, reserve ledger row);
  - `decideWithdrawalSync` (status guard, then paid with `txRef`, or rejected with a refund ledger row);
  - `adjustWalletSync` (reason required).

  ← (verify: two concurrent full-balance requests → exactly one succeeds; a negative balance blocks withdrawal; a decided withdrawal → 409)

## 3. Repo and deletion

- [x] 3.1 `src/lib/db/repos/affiliateRepo.js`: async wrappers that resolve the adapter and open `db.transaction` around the sync functions. Also:
  - list queries with aggregates (clicks, signups, paying referrals, earned/balance per currency);
  - a shared-IP hint, for the visible page only.
- [x] 3.2 `userRepo.createUser` accepts `referredByUserId`; it writes it and `referredAt` in the same INSERT.
- [x] 3.3 `userRepo.deleteUser`, inside the existing transaction:
  - delete `affiliates` and `affiliateLedger` rows;
  - set `emailSnapshot` on withdrawals;
  - keep commissions (D10).
- [x] 3.4 Export giftRepo's `inWindow`, and add `eligibleReferralGiftSync(db, giftCodeId)`: new-user, active, in window, not exhausted. Saving a non-new-user code as default or override is refused with 400.

## 4. Attribution and register

- [x] 4.1 `src/app/r/[code]/route.js` (GET), per design D6:
  - set the cookie;
  - count the click once per browser, rate-limited per IP;
  - 302 to `/register?ref=` or `/register`.

  Add `"/r"` to `PUBLIC_PAGE_PATHS` in `src/dashboardGuard.js`.
- [x] 4.2 `POST /api/public/register`:
  - resolve `body.ref || cookie dr_ref` with `resolveReferrerSync`;
  - pass the referrer to `createUser`;
  - clear the cookie;
  - leave the response body byte-for-byte unchanged in shape.
- [x] 4.3 Register page:
  - `page.js` resolves the referral and its eligible gift server-side and passes it to `RegisterForm`;
  - the banner shows "Bạn được giới thiệu", the gift code and the Telegram note;
  - the form sends `ref`.

  ← (verify: an invalid or blocked code gives a response identical to no code; the referrer email is never rendered; an existing account is never re-attributed)

## 5. Customer API and UI

- [x] 5.1 `/api/account/affiliate` (GET), `/payout` (PUT), `/commissions`, `/referrals`, `/withdrawals` (GET, POST) and `/gift` (GET), per design D8.
  - Masked emails only.
  - Notify the admin on Telegram after a withdrawal request, with a masked destination.
- [x] 5.2 `/account/affiliate` page, per design D9, and the "Giới thiệu" nav item in `AccountShell`. The item is shown when the program is enabled or the account has wallet history.
- [x] 5.3 `/account/gift`:
  - a "Quà giới thiệu" callout;
  - an `initialCode` prop on `GiftRedeemForm`;
  - the existing Telegram flow is unchanged.

  ← (verify: a referred account without Telegram sees the prefilled code, redeeming it prompts Telegram, and after linking the code redeems under the unchanged new-user rules)

## 6. Admin API and UI

- [x] 6.1 `/api/affiliates` (GET), `/api/affiliates/[userId]` (GET, PATCH), `/api/affiliates/[userId]/adjust` (POST), `/api/affiliates/commissions` (GET), `/api/affiliates/withdrawals` (GET) and `/api/affiliates/withdrawals/[id]` (PATCH).
  - Admin identity comes from `getAdminIdentity()`.
  - Every write is audited on the affected account.
- [x] 6.2 `PATCH /api/users/[id]/referrer`:
  - set or clear, reason required;
  - refuse self and unknown referrers;
  - audited;
  - no retroactive commission.
- [x] 6.3 `/dashboard/affiliates` with the tabs Cài đặt / CTV / Hoa hồng / Rút tiền, and the "Affiliate" item in `Sidebar.js`.
  - The rate is entered in percent and converted to bp.
  - The gift picker lists only new-user codes.
- [x] 6.4 User detail page: a "Người giới thiệu" field with set/clear, and the affiliate summary.

  ← (verify: every `/api/affiliates/**` route refuses a customer-only session; overrides fall back to the defaults when cleared; withdrawal decisions update the balances as specified)

## 7. Tests and checks

- [x] 7.1 `test/affiliate.test.js`, against throwaway SQLite (pattern in `test/billing.test.js`), covering every scenario in `specs/affiliate-program/spec.md` and `specs/account-registration/spec.md`. At minimum:
  - code stability and uniqueness;
  - accrual on admin approve and on a reconciler-style call;
  - idempotency;
  - first 1, first 5 and unlimited orders;
  - a refund freeing the slot;
  - VND / USDT / manual base amounts and rounding;
  - BigInt on a huge amount;
  - hold, release and reversal (pending and available);
  - negative balance;
  - withdrawal minimum, concurrency, reject refund and double decision;
  - blocked and deleted referrer;
  - program disabled;
  - gift eligibility and save validation;
  - `maskEmail`;
  - the sync settings reader.

  Each test must fail when its fix is removed.
- [x] 7.2 `npm run lint` (0 errors), `npm test` (all pass) and `npm run build`.

  ← (verify: the full suite passes, no new lint errors, the build succeeds)
- [ ] 7.3 Update the customer docs (`content/docs/`) with a short "Giới thiệu bạn bè" page. Merge the deltas into `openspec/specs/` and archive when the owner approves.

## 8. Review fixes

- [x] 8.1 `/r/<CODE>` redirects with a relative `Location` (absolute redirects pointed at the Docker listen address `0.0.0.0:20127`); `Secure` follows the public origin.
- [x] 8.2 First N counts the buyer's PAID orders (owner decision), not commissions; `setUserReferrer` creates the referrer's affiliate row; release skips deleted affiliates.
- [x] 8.3 Registration and the register page both take the first VALID code of `[ref, cookie]`.
- [x] 8.4 Withdrawals refused while the program is off; gift not advertised while off; page and nav use the same history test; Telegram shows only the last 4 characters; a null JSON body is a 400.
- [x] 8.5 Money inputs parsed exactly (`src/lib/affiliate/amountInput.js`): customer USD withdrawals in dollars, VND with dotted thousands, admin settings refuse blanks, server refuses `"100.000"`, booleans and blanks.
- [x] 8.6 Admin CTV modal sends only changed fields (an expired gift override no longer blocks other edits; the server also skips re-validating an unchanged override).
- [x] 8.7 UI: messages survive a refresh, the withdrawal history reloads, the referral gift never overwrites typed input and the callout disappears after redeeming, Vietnamese gift statuses, toggle label, deep link from the user page to the CTV row.

  ← (verify: each new test in test/affiliate.test.js fails when its fix is reverted)
- [x] 8.8 Second review: `GET /api/affiliates/[userId]` no longer 500s (stray body check moved into PATCH); the welcome gift is not advertised while the program is off or the referrer is blocked; the shared-IP hint reads both sides by userId (no quadratic self-join on `ip`); `gioi-thieu` docs page seeds as a draft (`published: false`); a deleted account's pending withdrawals are closed as rejected; admin order cancel / note writes are guarded by the status they read (`updateOrderStatus({ fromStatus })`); audit log labels for affiliate actions.
