## Context

The referral link (`/r/<CODE>`) sets `dr_ref` and today redirects to `/register?ref=<CODE>`. The promo popup (`PromoPopupSlot` server component plus the `PromoPopup` client dialog) is rendered on the landing, `/register`, the docs and the account area. The buyer bonus terms (`buyerBonusTermsForReferrerSync`) and the advertised welcome gift (`referralGiftForSync`) already exist for the register banner.

Admin affiliate tooling is read-only for commissions. The only ways to change commission state today are refunds (`reverseCommissionForOrderSync`) and the automatic release when the hold ends (`releaseRowSync` via `releaseDueSync` and `releaseAllDueSync`).

## Goals / Non-Goals

**Goals:**
- A referral visitor lands on `/` and is told, in one popup, what the invitation gives them, merged with any live promo.
- An admin can release, cancel and inspect commissions and referred accounts, without touching the database.

**Non-Goals:**
- Approving signups before they count (there is no "pending referral" state). "Duyệt trước" means releasing a held commission early.
- Bulk actions.
- Cancelling a commission automatically when a referrer is removed: these are separate, deliberate actions.

## Decisions

### D1. Redirect to `/`, benefits computed on the server
`/r/<CODE>` keeps setting the cookie and redirects to `/`. `PromoPopupSlot` reads `dr_ref` on the server and builds `{ code, bonus: {bp, maxOrders}, giftCode }`:
- `resolveFirstReferralSync` validates the code (program on, CTV not blocked);
- `buyerBonusTermsForReferrerSync` gives the bonus;
- `referralGiftForSync` gives the gift code.

The browser therefore never looks a code up. It only receives the benefits of the code it already carries.

The referral is skipped for:
- a signed-in customer, since an existing account is never attributed by a link;
- the account area;
- `/register` (`withReferral={false}`), whose banner already lists the same benefits.

### D2. One popup, merged content (`combinePopup`)
`combinePopup(copy, referral)` is pure and shared by the client and the test:

| Promo live | Referral | Result |
|---|---|---|
| no | no | `null` |
| yes | no | the promo unchanged |
| any | yes | the promo's title, body, code and CTA when live, otherwise "Bạn được mời dùng thử" and "Đăng ký nhận ưu đãi" |

When a referral is present:
- a `referral` block is added with the benefit lines from `referralBenefits`;
- the delay is capped at 1 s, because a referral visitor arrived with intent.

A referral whose benefit list is empty (no buyer bonus, no eligible welcome gift — the default settings) is treated as no referral. Otherwise an empty "you are invited" dialog would promise offers that do not exist, and would re-show a promo the visitor already closed.

The version hash covers the referral code and the benefit lines, so a visitor who closed the plain promo still sees it once more when they arrive through a link. The repeat window still applies.

The button target is built by `promoTargetHref(code, { signedIn, refCode })`, giving `/register?ref=<REF>&next=/account/gift?code=<CODE>`. With no promo code, the referral's gift code is used as the code. Following the button remembers that code as the pending gift, the same as the promo code.

### D3. Commission actions reuse the existing state machine
- `releaseCommissionNowSync(db, id, {actor, reason})` calls the same `releaseRowSync` as the automatic release, so the status guard, `releasedAt` and the single `commission` ledger row cannot diverge. It also writes the audit row `affiliate_commission_released`. A non-pending row is a no-op.
- `reverseCommissionByIdSync(db, id, {actor, reason})` requires a non-empty reason and calls `reverseCommissionRowSync`. That function is the body of the old `reverseCommissionForOrderSync`, extracted so refunds and admin cancels share it: the status guard, the negative `reversal` ledger row for an available commission, and the `affiliate_commission_reversed` audit row.

The first-N counters (commission and buyer bonus) count the buyer's `paid` orders, not commissions. An admin cancel leaves the order paid, so its slot stays used. Only a refund, which turns the order `refunded`, frees a slot. This is the safer behaviour: a cancelled fraudulent order does not open a new commission slot.

The early release also applies the automatic release's other guard: the affiliate must still exist (design D10 of `affiliate-referrals`; a deleted affiliate's wallet is gone). It moves `availableAt` back to the release time, so "available from" does not keep showing the original end of the hold.

Reasons follow `validateReason` (3–500 characters) like every other audited admin action. A reason is optional for a release and required for a cancel.

`actOnCommission(id, action, …)` in the repo wraps both in one transaction. It maps each failure to an error code (`not_found`, `not_pending`, `already_reversed`, `bad_action`), and the route turns those into 404, 409 or 400 with Vietnamese messages.

### D4. Referral list is one page query plus one grouped query
`listReferrals` does the following:
- selects users with `referredByUserId IS NOT NULL`, joined to the referrer and its `affiliates` row, with a correlated count of paid orders (`idx_orders_user_status`);
- groups `affiliateCommissions` by `(referredUserId, affiliateUserId, currency, status)` for the page's ids (`idx_ac_referred`), and keeps only the groups of the account's current referrer, so an earlier referrer's earnings are not shown under the new one;
- treats `%` and `_` in the search as literal characters (`ESCAPE`);
- runs `releaseAllDueSync` first, so "held" and "available" are current, as `listCommissions` already does.

"Gỡ giới thiệu" reuses `PATCH /api/users/[id]/referrer` with `referrerUserId: null` and a reason. That route already audits as `referrer_changed`.

### D5. Access mode is a setting plus an invitation date
- `affiliateAccess` (`open` | `invite`, default `open`) lives in the settings blob next to `affiliateEnabled`, validated by `validateAffiliateSettings`.
- The invitation is `affiliates.invitedAt`, not a new status: `status` stays the block switch, and an invitation survives a block. Re-inviting keeps the original date; withdrawing sets it to NULL. Both go through `updateAffiliate` (audited `affiliate_updated`); `inviteAffiliate(who)` creates the row and code when missing and audits `affiliate_invited`.
- One predicate decides whether a link records new users: `linkActive(row, settings)` = program on, not blocked, and (`open` or `invitedAt` set). `resolveReferrerSync` uses it, so `/r/<CODE>`, the register page, registration and the visitor popup all follow it with no other change.
- Earning from existing referrals is deliberately not gated by the mode (owner decision): commission accrual, the buyer bonus and the referred buyer's gift prefill check only the program switch and the block, as before. Wallet spending is not gated either.
- The "Program settings" table is not modified here: the still-active `affiliate-credit-vouchers` change also rewrites it, and two MODIFIED copies would conflict on archive. "Affiliate access mode" names the setting, its values and default; whichever change archives second adds the `affiliateAccess` row to the table.
- The customer area uses `affiliateAreaAvailableSync`: program on and allowed to refer, or something to keep (wallet history, or at least one referred user, because those still earn). `getAffiliateOverview` calls `ensureAffiliateSync` only when `mayRefer`, so an uninvited account never gets a code by opening the page. The API returns `canRefer`; the link, code, terms and gift are sent only when it is true.

## Risks / Trade-offs

- **Landing instead of register may lower immediate signups.** Mitigation: the popup opens after at most 1 s and its button goes straight to `/register?ref=`.
- **Switching to invite mode silently stops existing links.** The setting's hint says so; uninvited CTVs see "Đường dẫn tạm ngừng" on their page. The admin can invite them back from the CTV list (filter "Chưa mời").
- **Cancelling an available commission can make the wallet negative** if the CTV already spent it. This is the existing refund behaviour; a negative balance blocks spending. The dialog says so.
