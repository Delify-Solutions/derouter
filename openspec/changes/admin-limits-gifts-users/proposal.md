## Why

The owner wants four admin tools that do not exist yet:
- set a different RPM/TPM on one customer's purchase (`/dashboard/users/<id>?tab=plans`) without changing the plan for everyone;
- give credit gift codes an RPM/TPM — today a credit-only gift has no rate limit at all;
- delete gift codes, and edit every field of an existing code, including what it grants and the code string;
- lock and delete a customer from the user page.

## What Changes

- **Per-purchase RPM/TPM override.**
  - `userPlans` gains `rpm` and `tpm` (NULL = follow the plan live, 0 = no limit, > 0 = this rate).
  - Enforcement, the account page and `/usage` all read the effective value: the override, else the plan's.
  - A purchase without a plan (credit gift, admin credit) gets its own allowance when it has an override; without one it stays unlimited, as today.
  - The admin "Gói" tab gains "Sửa RPM/TPM" per purchase. The action needs a reason, is audited as `plan_rates_changed`, and cannot leave an unlimited-credit purchase with no bound.
- **Gift code RPM/TPM.** `giftCodes` gains `rpm` and `tpm`, which are written onto every purchase the code grants. Empty = the plan's own (none for a credit gift).
- **Edit every field of a gift code.**
  - The edit dialog becomes the same form as creation: code string, plan/credit/amount/duration, RPM/TPM, limits, dates, new-user flag and note.
  - **BREAKING (rule change):** what a redeemed code grants may now be changed. The change applies to later redemptions only; purchases already granted keep what they received. The total still cannot drop below the redemptions made.
  - The code string may be changed (same rules as a new code, unique among all codes ever created).
- **Delete a gift code.** "Xóa" replaces "Disable" (the on/off switch stays).
  - A code nobody redeemed is removed.
  - A redeemed code is soft-deleted (`deletedAt`): hidden from the list and the affiliate gift picker, never redeemable, not editable. Its redemptions and granted purchases stay.
- **Lock / delete a user from the user page.** The user detail header gains:
  - "Khóa tài khoản" / "Mở khóa" (status `suspended` / `active`, with a reason);
  - "Xóa tài khoản" (type the email to confirm).

  Both use the existing audited APIs.

## Capabilities

### New Capabilities
- (none)

### Modified Capabilities
- `plan-templates`: plan rates can be overridden per purchase.
- `gift-codes`: RPM/TPM on codes, every field editable, delete.
- `admin-user-management`: the RPM/TPM action, and lock/delete buttons on the user page.
- `api-access-enforcement`: customer rates come from the paying purchase (override, else plan), and a planless purchase with an override is limited.
- `plan-queue-billing`: an unlimited purchase and an unlimited-plan gift code must keep a bound, counting the purchase's own RPM/TPM.

## Impact

- Schema: `userPlans.rpm`, `userPlans.tpm`, `giftCodes.rpm`, `giftCodes.tpm`, `giftCodes.deletedAt` (additive); `SCHEMA_VERSION` 29 → 30.
- Code:
  - `src/lib/billing/planQueue.js` (`effectiveRate`, `rateKeyOf`, `ratePlanIdSync`), `rates.js`, `grants.js`, `adminActions.js` (`setPurchaseRatesSync`);
  - `src/lib/auth/keyEnforcement.js`, `src/app/api/usage/key/route.js`, `src/app/api/account/plans/route.js`, `src/lib/db/repos/accountPlansRepo.js`;
  - `src/lib/db/repos/giftRepo.js`, `src/app/api/gift-codes/**`, `src/app/api/affiliates/gift-codes/route.js`, `src/app/api/users/[id]/plans/[userPlanId]/route.js`;
  - UI: `PlansTab.js`, `AuditTab.js`, `UserDetailClient.js` + `AccountActions.js`, `GiftCodesPageClient.js` + `GiftCodeFormModal.js` (replaces `EditGiftCodeModal.js`).
- Tests: `test/rate-overrides.test.js` (new), `test/gift.test.js` and `test/plan-visibility.test.js` updated.
