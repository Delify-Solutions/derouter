## 1. Expiry in both directions
- [x] 1.1 `adminActions.js`: `setPlanExpirySync` replaces `extendPlanSync`; `expiresAt` in either direction, signed `days`, and both refused when the result is not in the future.
- [x] 1.2 Audit `plan_expiry_set` with `direction`; no ledger row, no balance change.
- [x] 1.3 `PATCH .../plans/[userPlanId]` takes `action: "expiry"`.
- [x] 1.4 `PlansTab`: "Sửa hạn dùng" with a `datetime-local` field pre-filled from the purchase and ±7 / ±30 presets.

## 2. Bulk delete
- [x] 2.1 `DELETE /api/users` with `userIds` (max 50, de-duplicated) and a required `reason`; per-account cascade, partial failures reported.
- [x] 2.2 `deleteUser` accepts `reason` and carries it into the surviving `user_deleted` audit row.
- [x] 2.3 `UsersPageClient`: row checkboxes, page select-all, count bar, confirm dialog listing the emails with the reason field, result banner; the selection is cleared on any page/filter/sort change.

## 3. Checks
- [x] 3.1 `test/admin-actions.test.js` covers shorten, extend, past-date refusal, zero days and revoked; `test/user-delete.test.js` covers a batch, the surviving reason and missing accounts.
- [x] 3.2 `npm test` (996 pass, 1 pre-existing affiliate failure), `npm run lint` (0 errors), `npm run build`.
- [x] 3.3 Verified in the browser: expiry 12/12 → 20/11 keeping $250, and deleting 2 selected accounts with the audit reason.
