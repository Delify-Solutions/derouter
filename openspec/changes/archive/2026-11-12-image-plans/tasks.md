## 1. Data model
- [x] 1.1 `src/lib/db/schema.js`: `plans.kind` / `plans.imageCount`, `orders.kind` / `orders.imageCount`, `userPlans.kind` / `imageTotal` / `imageRemaining`, `userPlanWindows.spentImages`, `creditLedger.deltaImages` / `balanceAfterImages`; `SCHEMA_VERSION` 31 → 32.
- [x] 1.2 `src/lib/billing/planKind.js` (new, pure): `normalizePlanKind`, `isImagePlan`, `planKindLabel`, `imageCount`.
- [x] 1.3 `src/lib/billing/limits.js`: `maxImages` on a limit, unit-aware validation against the plan's own balance, `describeLimit` reading "ảnh" for an image limit; a credit limit keeps its old JSON shape byte for byte.

## 2. Engine
- [x] 2.1 `planQueue.js`: kind-scoped `admitSync`/`queueViewSync`, image preference then credit fallback, `evaluatePlan` reading the unit of the purchase, `applyImageTake`, image split before the money passes with the covered share of the cost dropped, `rebuildWindowsSync` reading image movements.
- [x] 2.2 `grants.js`: `kind` and `imageCount` on `grantUserPlan`, an image purchase storing 0 credit, per-period images, `revoke`/`expire` in images.
- [x] 2.3 `orders.js` / `checkout.js`: snapshot `kind` + `imageCount` at order creation and grant the snapshot at approval.
- [x] 2.4 `adminActions.js`: grant, revoke and limits actions carry the plan's kind and report the image movement.
- [x] 2.5 `rates.js`: rates come from the purchase that pays for the request's kind.

## 3. Request path
- [x] 3.1 `keyEnforcement.js` / `sse/services/auth.js`: `requestKind` threaded through rate, admission and the concurrency cap.
- [x] 3.2 `imageGeneration.js`: asks admission for an image-kind decision; a customer key may serve an unpriced image model when an image purchase pays for it.
- [x] 3.3 `usageRepo.js`: image requests charge `imageCount` images alongside the cost.

## 4. Admin and customer surfaces
- [x] 4.1 Admin plan form: kind switch, image count instead of credit, image limits in each row, image preview, card badge and balance.
- [x] 4.2 `billingRepo.js`: `rowToPlan` / `validatePlanInput` / `createPlan` / `updatePlan` / stats handle both kinds and refuse the other kind's fields.
- [x] 4.3 Group allow-list picker lists text and image combos with the kind shown.
- [x] 4.4 Customer plans page: image balance and image limits per card, available images above the queue, buy card showing a count and no top-up.
- [x] 4.5 Account overview: image balance beside credit; the model list includes image combos.
- [x] 4.6 Landing: plan card shows a count and image-specific perks, catalogue and pricing split text from image, per-image price table.
- [x] 4.7 Ledger (customer and admin), inactive-plan tab, admin purchase history and the admin limits/revoke dialogs read in images for an image purchase.

## 5. Docs and checks
- [x] 5.1 `content/docs/plans.md` and `content/docs/models.md`: image plans, per-image billing, two ways to pay for an image.
- [x] 5.2 `test/image-plans.test.js` (23 cases): storage, admission, charging, windows, expiry/revoke, validation, plan CRUD.
- [x] 5.3 `npm test` (952 tests, 1 pre-existing affiliate failure), `npm run lint`, `npm run build`.
- [x] 5.4 Merge the deltas into `openspec/specs/` and archive the change (after owner review).
