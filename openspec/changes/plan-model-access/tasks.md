## 1. Storage
- [x] 1.1 `src/lib/db/schema.js`: `allowedModels` on `plans`, `orders` and `userPlans`; `SCHEMA_VERSION` 37 → 38.
- [x] 1.2 `src/lib/billing/planModels.js`: `normalizePlanModels`, `planAllowsModel`, `unionOfModels`, `modelsRestrictionOf` — one place the rules live, pure, so admission, charging and every listing agree.

## 2. Engine
- [x] 2.1 `planQueue.js`: `rowToEntry` carries the purchase's `allowedModels`; `admitSync` takes the requested model and filters by it; an ineligible purchase never contributes a 429 reopen.
- [x] 2.2 `planQueue.js`: `chargeSync` takes the same model and applies the same filter to both passes, so a request can never be billed to a purchase that does not allow it.
- [x] 2.3 `ratePlanIdSync` passes the model through, so the recorded RPM/TPM allowance is the purchase that actually paid.
- [x] 2.4 No extra query: the filter reads the `allowedModels` already selected by `listQueueSync`.

## 3. Enforcement
- [x] 3.1 `keyEnforcement.js`: compute the effective model set (group ∩ live purchases' union) and enforce it before admission; pass the model to `admitSync`.
- [x] 3.2 `rates.js`: pass the model through `payingRatesSync`.
- [x] 3.3 `sse/handlers/imageGeneration.js`: same for image requests.
- [x] 3.4 `usageRepo.js`: pass `requestedModel` into `chargeSync` and `ratePlanIdSync`.

## 4. Admin
- [x] 4.1 `billingRepo.js`: `validatePlanInput` accepts `allowedModels` (null or non-empty, each entry an existing combo name), `rowToPlan` returns it, `createPlan`/`updatePlan` store it.
- [x] 4.2 `createOrder` and `approveOrderSync` snapshot it into `orders`; `grantUserPlan` carries it into `userPlans` from the order, the admin grant and a gift code.
- [x] 4.3 `adminActions.js`: `applyModelsToActiveSync` rewrites live purchases with one audit entry each; `PATCH /api/plans/[id]` honours `applyToActive`.
- [x] 4.4 Plan admin form: model picker beside "Nhóm được mua", empty = no restriction, warning with a live count before an apply-to-active removal.

## 5. Listings
- [x] 5.1 `/v1/models` and `/v1/models/[kind]`: scope by the effective set, not the group alone.
- [x] 5.2 `/api/account/chat/models`, the account page and the landing catalogue: same set.
- [x] 5.3 Customer queue card: name the models a restricted purchase covers.

## 6. Checks
- [x] 6.1 `test/plan-models.test.js`: admission by model, charging to the right purchase, the 429-vs-402 distinction, a plan never widening the group, expiry removing access, the union of two purchases.
- [x] 6.2 Order/gift snapshots keep what was sold when the plan changes afterwards.
- [x] 6.3 `npm test`, `npm run lint`, `npm run build`; a live check of a restricted plan against a real combo.
