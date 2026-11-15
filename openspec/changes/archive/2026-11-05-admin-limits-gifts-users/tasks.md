## 1. Per-purchase RPM/TPM

- [x] 1.1 Schema: `userPlans.rpm`, `userPlans.tpm`; `SCHEMA_VERSION` 30
- [x] 1.2 `planQueue.js`: `effectiveRate`, `rateKeyOf`; queue entries carry the effective rate and the raw override; `ratePlanIdSync` uses `rateKeyOf`
- [x] 1.3 `rates.js`: LEFT JOIN, effective rate, `rateKey`; consumers (enforcement, slot, `/api/usage/key`, `/api/account/plans`) count by `rateKey`
- [x] 1.4 `grants.js`: `grantUserPlan({ rpm, tpm })` writes the override
- [x] 1.5 `adminActions.setPurchaseRatesSync` + route action `rates`; unlimited guards per purchase
- [x] 1.6 Plans tab: "Sửa RPM/TPM" dialog; the limits dialog prefilled from the queue's windows; audit label ← (verify: an override changes enforcement on the next request; a planless override is counted and checked under the same key; 0 vs empty)

## 2. Gift codes

- [x] 2.1 Schema: `giftCodes.rpm`, `giftCodes.tpm`, `giftCodes.deletedAt`
- [x] 2.2 `createGiftCode` / `updateGiftCode` accept RPM/TPM; `updateGiftCode` edits every field including the code string; the grant lock is removed
- [x] 2.3 `redeemGiftCode` writes the code's RPM/TPM onto the purchase; a deleted code is `not_found`
- [x] 2.4 `deleteGiftCode`: hard when unused, soft when used; lists and picker exclude deleted codes
- [x] 2.6 An unlimited-plan code cannot remove every bound (save and redeem); an edit of other fields keeps a stranded top-up amount
- [x] 2.7 Delete frees the code string (`~deleted~` suffix, `liveGiftCode` for history) and unlinks the code from the referral default, CTV overrides (audited) and the popup in the same transaction; `listGiftCodes` returns `usage`; a rename carries the popup code along ← (verify: a deleted string can be created again and redeems the new code; the old history still shows the old string; nothing still points at a deleted code)
- [x] 2.5 `GiftCodeFormModal` for create and edit; "Xóa" with a confirmation that names the outcome; RPM/TPM shown in the list ← (verify: editing a redeemed code changes only later redemptions; a soft-deleted code cannot be redeemed or edited; the delete dialog lists where the code is used)

## 3. Users

- [x] 1.7 The keys page's pin picker shows each plan's effective rate (first purchase of the plan, override applied)
- [x] 3.1 `AccountActions` in the user header: lock/unlock with a reason, delete with the email typed back

## 4. Checks

- [x] 4.1 Tests: `test/rate-overrides.test.js`; updated `gift.test.js`, `plan-visibility.test.js`
- [x] 4.2 `npm test`, `npm run lint`, `npm run build`, live check of the three admin screens and a rate-limited request
