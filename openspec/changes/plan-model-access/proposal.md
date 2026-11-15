## Why

A group decides which models an account may call, and a plan decides nothing about models — so every plan held by a member of one group grants identical model access. A $5 plan and a $500 plan in the same group can call exactly the same models; the only difference is how fast the credit drains.

That cannot express the product the owner wants: *this plan includes Claude, that plan does not*. Group membership is a property of the **account**, but a customer holds **several plans at once**, so "plan Claude" and "plan GPT" cannot both be expressed by one group.

`planModelLimits` (commit `6fbcc1da`, dropped by migration `006`) is not the answer — that was a per-model **monthly money ceiling**, a different feature. This change is an **eligibility list**: which models a purchase is allowed to call at all.

## What Changes

- **`plans.allowedModels`**: a nullable list of combo names. `NULL` = no restriction (every plan today), so an existing installation behaves exactly as before.
- **A plan can only narrow the account's access, never widen it.** The effective set for a request is *group allow-list ∩ plan allow-list*. A plan cannot grant a model the group denies, because the group allow-list is the account-level ceiling and is enforced first.
- **A model is callable while at least one live purchase allows it**, and the model list every surface shows (`/v1/models`, the account page, the customer chat model endpoint, the landing catalogue) is the **union** over live purchases, intersected with the group.
- **The purchase that pays must allow the model.** Admission filters by the model, not only by kind, and **so must charging** — the charge engine re-reads the queue and would otherwise bill an unrelated purchase.
- **Snapshot into `orders` and `userPlans`**, like `limits`/`kind`/`rpm`, with an explicit "apply to active purchases" admin action, so editing a plan cannot silently strip access from someone who already paid.
- **A blocked-by-eligibility purchase is not the same as a blocked-by-quota one**: a purchase that allows no model for this request is skipped as ineligible (402 when nothing else can pay), never reported as 429 waiting for a window.

## Capabilities

### Modified Capabilities
- `plan-templates`: the plan definition carries an optional model list; orders and purchases snapshot it; applying a change to live purchases is an explicit action.
- `plan-queue-billing`: admission and charging filter by the request's model.
- `api-access-enforcement`: a customer key's effective model set is the group's list narrowed by the paying plan's list; the model listing reflects it.
- `customer-portal`: the customer's model list is the union over live purchases.

## Impact

- **Code**: `src/lib/billing/planQueue.js` (`admitSync`, `chargeSync`, `ratePlanIdSync`, `rowToEntry`), `src/lib/auth/keyEnforcement.js`, `src/lib/billing/rates.js`, `src/sse/handlers/imageGeneration.js`, `src/lib/billing/adminActions.js` (`applyModelsToActiveSync`), `src/lib/db/repos/billingRepo.js` (validate/create/update/order snapshot), `src/lib/billing/grants.js`, `src/lib/db/repos/giftRepo.js`, `src/lib/db/repos/usageRepo.js` (pass the model to the charge), the plan admin form, and the four model-listing call sites.
- **Schema**: `plans.allowedModels`, `orders.allowedModels`, `userPlans.allowedModels`; `SCHEMA_VERSION` 37 → 38.
- **API**: `PATCH /api/plans/[id]` accepts `allowedModels` and `applyToActive`; `GET /api/plans` returns it; the purchase payload exposes the snapshot.
- **Out of scope**: per-model *spending* limits (that is what `planModelLimits` was, and it stays gone), model-level pricing per plan, and a separate allow-list per purchase that diverges from the plan (an admin can edit the plan and push it down, not hand-edit one purchase).
