## Context

RPM/TPM live on `plans` and are read live on every request (spec plan-templates "Plan rates").
- `payingRatesSync` picks the paying purchase, then INNER JOINs its plan. A planless purchase therefore had no rate.
- Usage is counted per allowance: `usageHistory.ratePlanId`, written by `ratePlanIdSync` and read by `getUserRateUsage(userId, window, planId)`.
- The concurrency slot is keyed the same way.

Gift codes have a soft "disable" (`isActive = 0`). Since PR #42, the grant is locked once a code is redeemed.

## Goals / Non-Goals

**Goals:**
- An admin can raise or lower one customer's RPM/TPM on one purchase, and give a credit gift a rate.
- An admin can fix any field of a gift code after creating it, and get rid of a code.
- Lock and delete are reachable from the user page.

**Non-Goals:**
- A per-key rate.
- Changing an existing purchase when its gift code is edited. Purchases are independent, as everywhere else in the plan queue.
- Bulk user actions in the list.

## Decisions

### D1. Override columns on the purchase; NULL follows the plan
`userPlans.rpm` and `userPlans.tpm` take one of three values:
- `NULL` = follow the plan, read live as today;
- `0` = no limit;
- `> 0` = this rate.

`effectiveRate(override, planValue)` is the single rule. It is used by:
- `rowToEntry`, for the queue shown on the account and admin pages;
- `payingRatesSync`, for enforcement and `/usage`;
- the unlimited-purchase guard.

Keeping NULL distinct from 0 lets an admin both remove a limit for one customer and return the purchase to "whatever the plan says" later.

### D2. Allowance key (`rateKeyOf`)
Allowances stay per (user, plan) for planned purchases: the key is the plan id. A purchase override changes the rate, not the bucket, so two purchases of one plan still share their minute.

A planless purchase works as follows:
- with an override, it gets its own bucket, `purchase:<userPlanId>`;
- without one, the key is null and no rate applies (unchanged behaviour).

`payingRatesSync` returns this as `rateKey`. All four consumers use it:
- the enforcement check;
- the concurrency slot;
- `/api/usage/key`;
- `/api/account/plans`.

`ratePlanIdSync` writes the same key into `usageHistory.ratePlanId`, so what is counted equals what is checked. `planId` keeps meaning the real plan.

### D3. Admin action `setPurchaseRatesSync`
`PATCH /api/users/[id]/plans/[userPlanId]` with `{action:"rates", rpm, tpm, reason}`:
- "" or null = follow the plan;
- integers 0…1e9 are accepted;
- the reason must be 3–500 characters.

Like limits, it is allowed for `active` or `exhausted` purchases. It refuses to leave an unlimited-credit purchase with no window limit and no effective rate. It writes the audit entry `plan_rates_changed` with before/after values and the plan's own values.

`applyLimitsToActiveSync` and `setPurchaseLimitsSync` now judge "has a rate" per purchase, override included.

### D4. Gift codes carry rates; edits apply forward
`giftCodes.rpm` and `giftCodes.tpm` use the same encoding as D1. `redeemGiftCode` passes them to `grantUserPlan`, which writes them on each period it inserts.

`updateGiftCode` accepts every field, including `code` and `amountVnd` (the route did not pass `amountVnd` before). It drops the "grant locked after redemption" rule because the owner wants to fix codes freely:
- earlier redemptions are separate purchases, so nothing already granted changes;
- the redemption history still names the code;
- `maxRedemptions >= redeemedCount` and the plan/credit exclusivity rules stay;
- a new rule: start ≤ expiry.

### D5. Delete: hard when unused, soft otherwise
`deleteGiftCode` checks whether the code has any `giftRedemptions` row:
- **No rows**: `DELETE` the code.
- **Rows exist**: set `deletedAt` and `isActive = 0`.

A soft-deleted code:
- is excluded from `listGiftCodes`, `getGiftCodeById`, `updateGiftCode` and the affiliate gift picker;
- is refused by `redeemGiftCode` (`not_found`);
- gives its string back (owner decision): the stored code becomes `<CODE>~deleted~<id>`. `UNIQUE` still holds, the redemption rows keep pointing at the same row id, and a customer can never type the value because input is normalised to A-Z0-9. `findGiftRowByCode` skips deleted rows, so creating or renaming onto the old string is allowed.

`listRedemptions` still works for it and shows the code through `liveGiftCode` (the part before `~deleted~`).

Unlinking (owner decision "warn, then unlink") happens in the same transaction, before the hard or soft delete:
- `settings.affiliateDefaultGiftCodeId` is cleared when it is this id;
- `settings.landingCopy.popupCode` is cleared when it names this code (compared normalised); the rest of the popup copy is left alone;
- every `affiliates.giftCodeId` equal to this id is set to NULL, with an `affiliate_updated` audit row on that CTV naming the deleted code.

Every admin-facing gift row (`listGiftCodes`, `getGiftCodeById`, `createGiftCode`, `updateGiftCode`) carries `usage: { referralDefault, affiliateCount, popup }` from one helper, so a row the page replaced after a toggle, edit or assign still feeds the dialog; the list computes it with one settings read and one grouped query so the confirmation can list those places; `DELETE` returns `unlinked` with the counts actually cleared.

Renaming is the other way a string reference can break. CTV and default references use the id and survive a rename; the popup uses the string, so `updateGiftCode` rewrites `landingCopy.popupCode` to the new string when it named the old one.

### D6. User page actions reuse existing APIs
`AccountActions` sits in the user detail header:
- **Lock / unlock**: `PATCH /api/users/[id]` with `{status, reason}` through `ReasonModal`, the existing audited status change. Suspension revokes sessions and blocks the API.
- **Delete**: `DELETE /api/users/[id]` with `confirmEmail`. The button is enabled only when the typed email matches. The dialog lists exactly what `deleteUser` removes. On success it returns to the list.

## Risks / Trade-offs

- **An edited gift may confuse support** ("why did A get $5 and B $50 from one code?"). Mitigation: the edit dialog says changes apply to later redemptions, and each purchase's ledger `meta` names the gift.
- **A soft-deleted code's string can never be reused.** This is acceptable and stated in the error message.
- **A planless purchase with an override opens a separate allowance**, so a customer holding such a credit gift and a plan can use both minutes when each pays in turn. This matches how two different plans behave today.
