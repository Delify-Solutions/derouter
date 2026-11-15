## Why

Two gaps in the admin console:

1. **Expiry could only move forward.** The purchase action was "Gia hạn" and took a day count; the API refused any date earlier than the current expiry. An operator ending a trial early, correcting a mistyped 365-day grant or honouring a customer's request to shorten had one option — revoke the whole purchase — which also throws away the credit and the history.
2. **Deleting accounts was one at a time.** The single-account route confirms with the account's own email, which is unusable for cleaning up a batch of test or duplicate accounts. The list page had no selection at all.

## What Changes

- **The action is "Sửa hạn dùng" and sets an exact end.** The modal takes a `datetime-local` value pre-filled from the purchase, with ±7 and ±30 day presets. The API accepts `expiresAt` in either direction and a signed `days`.
- **Shortening does not forfeit anything.** The purchase keeps its credit, its windows and its ledger; only the deadline changes. Ending a purchase now remains `revoke`, so the two intents stay distinct instead of both emptying the balance.
- **A new expiry must stay in the future.** A past date is refused with a message pointing at `Thu hồi`; a date at or before `startsAt` is refused too.
- **The list page gets bulk selection**: a checkbox per row, a select-all for the page, a bar showing the count, and a confirm dialog that lists the exact emails, requires a written reason, and reports what was deleted.
- **`DELETE /api/users`** deletes up to 50 accounts per request. Each deletion goes through the existing `deleteUser`, so the cascade and the audit row are exactly the single-account ones; no second delete implementation.
- **The reason survives the audit wipe.** `deleteUser` deletes the account's `userAuditLog` rows as part of the cascade, so the surviving `user_deleted` row now carries the operator's `reason` — the bulk path has no per-row email confirmation to fall back on.

## Capabilities

### Modified Capabilities
- `admin-user-management`: the expiry action edits both directions; new requirement for bulk delete.

## Impact

- **Code**: `src/lib/billing/adminActions.js` (`setPlanExpirySync`, replacing `extendPlanSync`), `src/app/api/users/[id]/plans/[userPlanId]/route.js` (`action: "expiry"`), `src/app/api/users/route.js` (`DELETE`), `src/app/(dashboard)/dashboard/users/[id]/components/PlansTab.js`, `src/app/(dashboard)/dashboard/users/UsersPageClient.js`, `src/lib/db/repos/userRepo.js` (`reason`).
- **API**: `PATCH .../plans/<id>` takes `action: "expiry"` instead of `"extend"`; a negative `days` is accepted. `DELETE /api/users` is new.
- **Audit**: the action name is `plan_expiry_set` (was `plan_extended`) with `details.direction`.
- **Out of scope**: bulk expiry edits, bulk suspend, undo of a deletion, and restoring a purchase that has already expired.
