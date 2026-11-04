## Why

The owner wants customers and collaborators (CTV) to bring in new buyers through a referral link and be paid a commission on what those buyers spend. Today the only acquisition incentive is the new-user gift code. Nothing records who brought a customer in, and nothing pays anyone for it. The owner also wants the referral link to advertise a welcome gift code, and that gift must keep its Telegram verification so referral signups cannot be farmed.

## What Changes

**Referral links**
- When the program is switched on (admin setting, off by default), every customer account gets a referral link `https://<domain>/r/<CODE>`. The code is short, random and unique, and is created the first time the customer opens the new page "Giới thiệu" (`/account/affiliate`).

**Attribution**
- Opening a link stores the code in a cookie (30 days by default, admin-configurable) and sends the visitor to `/register`. `/register?ref=<CODE>` works too.
- An account registered while a valid code is present is bound to that referrer for good. The referrer is recorded on the account.
- Existing accounts are never attributed by a link. Only an admin can set or clear an account's referrer, with a reason, and that change is audit-logged.

**Welcome gift on the link**
- The admin chooses a default gift code for referral links. A different code can be chosen for each affiliate (CTV).
- Only an active **new-user** gift code can be chosen. A new-user code requires a linked Telegram account. The gift code itself is still created on the existing gift codes page.
- The register page and `/account/gift` show the code to referred visitors and accounts, prefilled. Redeeming it follows the existing new-user rules unchanged, Telegram link included.

**Commission**
- Commission is earned on the first **N paid orders** of each referred customer.
  - The rate is in basis points. N = 0 means every order earns commission.
  - The admin sets a default rate and a default N, and can override either for any affiliate (a CTV deal).
- Commission is computed when an order becomes `paid`, on any approval path (gateway auto-match or admin approval), and is recorded in the currency the customer paid: đồng for VietQR, nano-USD for Binance or manual orders. There is no exchange rate.
- Commission is held for a hold period (admin setting, 7 days by default) before it can be withdrawn.
- When the order is refunded, its commission is reversed. If the commission had already been released, the reversal is a negative entry, so the balance can go below zero.

**Commission wallet and withdrawals**
- Each affiliate has a commission wallet with a separate balance per currency (VND, USD).
- An affiliate saves payout details (a bank account for VND, a USDT address or Binance ID for USD) and requests a withdrawal of at least the admin minimum.
- The requested amount is reserved as soon as the request is made. The admin marks the request **paid**, with a transfer reference, or **rejected**, which returns the amount. The admin is notified on Telegram.

**Admin**
- A new page "Affiliate" (`/dashboard/affiliates`) has:
  - program settings (on/off, default rate, default N, hold days, cookie days, minimum withdrawal per currency, default gift code);
  - the affiliate list, with per-affiliate rate / N / gift code overrides and a block switch;
  - commissions;
  - withdrawals (mark paid / reject).
- The user detail page shows who referred the account and the account's affiliate summary.

**Blocking**
- A blocked affiliate's link stops attributing new signups, and the affiliate earns no new commission.
- The affiliate's existing balance stays; the affiliate cannot request a withdrawal while blocked.

## Capabilities

### New Capabilities
- `affiliate-program`: covers
  - referral codes and links;
  - attribution;
  - commission rules (rate, first-N orders, hold, reversal);
  - the commission wallet and withdrawals;
  - the referral welcome gift;
  - the customer page and the admin page.

### Modified Capabilities
- `account-registration`: registration binds the new account to the referrer whose code is present (cookie or `ref` parameter) and shows that referral's welcome gift code.

## Impact

**Database** (additive; `SCHEMA_VERSION` +1 over whatever `main` has at implementation time):
- new table `affiliates`, with one row per customer who has a code and their overrides;
- `users.referredByUserId` and `users.referredAt`;
- new tables `affiliateCommissions`, `affiliateLedger` and `affiliateWithdrawals`.

**Code**:
- `src/lib/affiliate/*` (new, driver-free, relative imports);
- `src/lib/db/repos/affiliateRepo.js` (new);
- `src/lib/billing/orders.js` (`approveOrderSync` accrues commission);
- `src/lib/db/repos/billingRepo.js` (`refundOrder` reverses it);
- `src/lib/db/repos/userRepo.js` (`createUser` takes the referrer; `deleteUser` cleanup);
- `src/app/api/public/register/route.js`;
- `src/app/r/[code]/route.js` (new);
- `src/dashboardGuard.js` (`/r` is public);
- `src/app/api/account/affiliate/**` and `src/app/api/affiliates/**` (new);
- `/account/affiliate`, `/account/gift` and `/register` UI;
- `/dashboard/affiliates`, the user detail page and the sidebars;
- `src/lib/db/repos/settingsRepo.js` defaults;
- `src/lib/notify/telegram.js`.

**Settings** (new keys):
- `affiliateEnabled`
- `affiliateDefaultRateBp`
- `affiliateDefaultMaxOrders`
- `affiliateHoldDays`
- `affiliateCookieDays`
- `affiliateMinWithdrawVnd`
- `affiliateMinWithdrawUsdNano`
- `affiliateDefaultGiftCodeId`

**Out of scope**:
- converting commission into API credit;
- automatic payouts;
- multi-level (tiered) referrals;
- attributing existing accounts by link.
