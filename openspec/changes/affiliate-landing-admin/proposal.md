## Why

A referral link currently drops the visitor straight onto `/register`. They have not seen the service yet, and they are not told what the invitation gives them. The owner wants the link to open the landing page, where the visitor can read about the service, with a popup listing the invitation's benefits. When the new-user promo popup is also running, both should appear in the same popup.

On the admin side, `/dashboard/affiliates` lists CTVs and commissions but cannot act on them. The owner wants to:
- see who each CTV referred;
- cancel a commission (fraud, a self-referral, an order that should not count);
- release a held commission early ("duyệt trước");
- remove a referrer from an account;
- choose who may be a CTV: every customer, or only accounts the admin invited.

## What Changes

- **Referral link goes to the landing page.** `GET /r/<CODE>` with a valid code sets the cookie as before, but redirects to `/` instead of `/register?ref=<CODE>`. Invalid codes still go to `/register`.
- **Referral benefits popup.** A visitor who is not signed in and carries a valid `dr_ref` cookie sees a popup on the landing and docs pages. It lists what the invitation gives:
  - the buyer bonus: X% extra credit for the first N paid orders, and X% off unlimited plans;
  - the welcome gift code, when one is advertised.

  When the promo popup is live, its title, body, code and button are kept and the benefits are added to it. Otherwise a referral-only popup is shown. The button leads to `/register?ref=<CODE>` (with the gift `next` when a code is shown). `/register` does not show the referral part, because its banner already lists the benefits.
- **Admin commission actions.** Each commission row in "Hoa hồng" gains:
  - **Duyệt ngay** (pending only): ends the hold now and credits the CTV wallet;
  - **Hủy** (pending or available): reverses it like a refund, with a mandatory reason. An available one is debited back from the wallet.

  Both are audited on the CTV's account.
- **Admin referral list.** A new tab, "Người được giới thiệu", lists every account with a referrer:
  - the referred email and status, the CTV email and code, and the date it was attached;
  - paid orders, and held and available commission;
  - search by either email or the CTV code, and a filter by CTV, reached from a CTV row.

  Each row can **Gỡ giới thiệu** (with a reason), using the existing referrer API.
- **Affiliate access mode.** A new setting `affiliateAccess`: `open` (default, today's behaviour: every customer gets a link) or `invite` (only invited affiliates). The admin adds an invited CTV by email or user id from the "CTV" tab ("Thêm CTV"), and can withdraw or restore an invitation per CTV. In invite mode:
  - an uninvited account's link stops recording new users (and its banner, popup and gift are no longer shown to visitors);
  - what it already has is kept: its wallet stays spendable, and the users it referred earlier keep earning commission and their buyer bonus;
  - the "Giới thiệu" item is hidden from an uninvited account that has nothing to keep, and opening the page creates no code for it.

## Capabilities

### New Capabilities
- (none)

### Modified Capabilities
- `affiliate-program`: the referral link redirect target changes. Adds the referral benefits popup, the admin commission actions, the admin referral list and the affiliate access mode.

## Impact

- Code:
  - `src/app/r/[code]/route.js`;
  - `src/shared/utils/promoPopup.js` (`referralBenefits`, `combinePopup`, `promoTargetHref` with `refCode`);
  - `src/app/landing/components/PromoPopup.js`, `PromoPopupSlot.js`;
  - `src/app/register/page.js`;
  - `src/lib/affiliate/commission.js` (`releaseCommissionNowSync`, `reverseCommissionByIdSync`);
  - `src/lib/db/repos/affiliateRepo.js` (`actOnCommission`, `listReferrals`);
  - new routes `PATCH /api/affiliates/commissions/[id]` and `GET /api/affiliates/referrals`;
  - access mode: `src/lib/affiliate/settings.js` (`affiliateAccess`), `src/lib/affiliate/core.js` (`mayRefer`, `linkActive`, `affiliateAreaAvailableSync`), `affiliateRepo` (`inviteAffiliate`, `invited` patch and list filter), `POST /api/affiliates`, `PATCH /api/affiliates/[userId]`, `src/app/account/layout.js`, `GET /api/account/affiliate` and the customer page;
  - `AffiliatesPageClient.js`;
  - the audit labels.
- Schema: `affiliates.invitedAt` (TEXT, nullable), `SCHEMA_VERSION` 31. Additive only. Version 30 is taken by the parallel change `admin-limits-gifts-users`.
- Tests: `test/promo-popup.test.js` and `test/affiliate.test.js`.
- This change builds on the still-active `affiliate-credit-vouchers` change (buyer bonus) and `promo-popup` change (the popup itself). It only adds requirements, plus a modification of "Referral link redirect", which neither of those changes touches.
