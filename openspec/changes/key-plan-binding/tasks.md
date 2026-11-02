## 1. Schema
- [x] 1.1 `apiKeys.planId`, `usageHistory.ratePlanId` in `src/lib/db/schema.js`; `SCHEMA_VERSION` 21.

## 2. Engine
- [x] 2.1 `planQueue.js`: `scopeQueue`, `admitSync(..., { planId })`, `chargeSync({ planId })`, `ratePlanIdSync`.
- [x] 2.2 `usageRepo.js`: stamp `ratePlanId`, pass the key's pin to `chargeSync`; `getUserRateUsage`/`getUserOldestTokenAt` take an optional `planId`.
- [x] 2.3 `keyEnforcement.js`: pinned admission, per-(user, plan) RPM/TPM and TPM lock; `platformError.js`: pinned-plan message, "của gói" wording.

## 3. Keys API and UI
- [x] 3.1 `apiKeysRepo.js`: `planId` on read, create and update (customer keys only).
- [x] 3.2 `accountPlansRepo.js`: `listBindablePlansSync`, `resolveKeyPlanInputSync`.
- [x] 3.3 `GET`/`POST /api/account/keys`, new `PATCH /api/account/keys/[id]`.
- [x] 3.4 `/account/keys`: "Áp dụng cho" select on create, plan tag per key, "Đổi gói" modal.

## 4. Tests and checks
- [x] 4.1 `test/key-plan-binding.test.js`; `test/access-enforcement.test.js` stamps `ratePlanId` on its usage rows.
- [x] 4.2 `npm test`, `npm run lint`, `npm run build` pass.
- [ ] 4.3 Merge the deltas into `openspec/specs/` and archive the change (after owner review).
