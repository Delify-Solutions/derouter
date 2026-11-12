## 1. Referral link and popup

- [x] 1.1 `/r/<CODE>`: a valid code redirects to `/` (cookie and click counting unchanged)
- [x] 1.2 `promoPopup.js`: `referralBenefits`, `combinePopup`, `promoTargetHref(code, { signedIn, refCode })`
- [x] 1.3 `PromoPopupSlot`: read `dr_ref` server-side for visitors who are not signed in; `withReferral` prop; render when the promo is live or a referral is present
- [x] 1.4 `PromoPopup`: benefits block, button to `/register?ref=`, the gift code remembered on follow
- [x] 1.5 `/register` passes `withReferral={false}` ← (verify: `/r/<valid>` → 302 to `/` with `dr_ref`; landing popup lists the benefits merged with a live promo; register shows no duplicate)

## 2. Admin commission actions

- [x] 2.1 `commission.js`: extract `reverseCommissionRowSync`; add `reverseCommissionByIdSync` (reason required) and `releaseCommissionNowSync` (audited)
- [x] 2.2 `affiliateRepo.actOnCommission` and `PATCH /api/affiliates/commissions/[id]`
- [x] 2.3 "Hoa hồng" tab: "Duyệt ngay" and "Hủy" with a confirmation dialog; cancel needs a reason; audit labels ← (verify: release writes exactly one ledger row and the later auto-release adds none; cancel of an available commission writes one reversal row; both audited; repeated actions are no-ops)

## 3. Admin referral list

- [x] 3.1 `affiliateRepo.listReferrals` and `GET /api/affiliates/referrals`
- [x] 3.2 "Người được giới thiệu" tab: search, CTV filter from the CTV row, link to the user, "Gỡ giới thiệu" via the referrer API ← (verify: only accounts with a referrer; held/available sums per currency; filter and search by CTV code)

## 4. Affiliate access mode

- [x] 4.1 Schema `affiliates.invitedAt`, `SCHEMA_VERSION` 31; setting `affiliateAccess` with validation
- [x] 4.2 `core.js`: `mayRefer`, `linkActive`, `affiliateAreaAvailableSync`; `resolveReferrerSync` uses `linkActive`
- [x] 4.3 `affiliateRepo`: overview creates a code only when `mayRefer`; `inviteAffiliate`; `invited` patch; `invited` list filter
- [x] 4.4 `POST /api/affiliates`, `invited` in `PATCH /api/affiliates/[userId]`, account layout and `GET /api/account/affiliate`
- [x] 4.5 Admin UI: access select in settings, "Thêm CTV" dialog, "Được mời" badge and filter, invitation select in the CTV dialog; customer page states; audit label ← (verify: invite mode refuses an uninvited code everywhere a code is resolved; existing referrals still accrue; an uninvited account gets no code by opening the page but can spend its wallet)

## 5. Checks

- [x] 5.1 Tests in `test/promo-popup.test.js` and `test/affiliate.test.js`
- [x] 5.2 `npm test`, `npm run lint`, `npm run build`, live check of `/r/<CODE>` and the admin actions
