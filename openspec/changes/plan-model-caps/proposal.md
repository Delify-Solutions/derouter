## Why

A plan today is one credit pool drained by every model alike. The owner wants a *separate bar* for a group of models inside that pool — the way Claude shows a distinct weekly bar for Opus. Example: plan "Goal" has $150 for DeepSeek and GLM until it runs out (shared pool), but image models may spend only $15 of it. Once $15 went to images, images are refused even though the pool still has money; the remaining credit keeps paying for the other models.

`plan-model-access` (eligibility list) decides *which* models a plan may call at all. This change adds a *spending cap on a set of models* within the pool. It is not `planModelLimits` (a separate per-model wallet, dropped in migration 006): the cap draws from the same pool, it only limits how much of it a model group may take.

## What Changes

- **`plans.modelCaps`**: a JSON list of caps `{ id, label, models: [combo names], maxNanoUsd, hours }`. `hours = null` caps the whole life of the purchase ("$15 for images, total"); `hours = N` caps each window of N hours, opened at first use like the existing limits. `NULL`/`[]` = no caps, which is every plan today.
- **Same pool**: spend on a capped model still reduces the purchase's credit and still counts in the purchase's window limits. A cap only *adds* a restriction.
- **Admission**: a purchase whose matching cap is full cannot pay for that model. Another purchase of the account may. When no purchase can pay and one is blocked by a cap, the request is refused with 429 `model_cap` that names the cap and, for a windowed cap, when it reopens (a whole-term cap has no reopen time). Other models keep working.
- **Charging**: pass 1 takes at most the room left in every matching cap; the overshoot of an admitted request is recorded like it is for windows (a cap can be exceeded by at most one request).
- **Read live from the plan**, like `rpm`/`tpm` (not snapshotted into orders and purchases): editing a cap applies to everyone holding the plan at once. Spend is tracked per purchase in `userPlanCapSpend`.
- **Visible to the customer**: the queue card shows one bar per cap (spent / max, resets when applicable).
- **Admin**: a "Giới hạn riêng theo model" section in the plan form (name, models, maximum in dollars, whole term or a window), and the plan card lists the caps.

## Capabilities

### Modified Capabilities
- `plan-templates`: the plan definition carries optional model caps and validates them.
- `plan-queue-billing`: admission and charging honour caps; the queue view exposes them.
- `api-access-enforcement`: a `model_cap` denial.

## Impact

- **Schema**: `plans.modelCaps`, new table `userPlanCapSpend(userPlanId, capId, startedAt, spentNanoUsd, updatedAt)`; `SCHEMA_VERSION` 38 → 39.
- **Code**: new `src/lib/billing/modelCaps.js` (pure); `planQueue.js` (`listQueueSync`, `evaluatePlan`, `admitSync`, `chargeSync`, `applyTake`, `queueViewSync`, `rebuildCapSpendSync`); `billingRepo.js` (plan row, validation, create/update); `keyEnforcement.js` + `platformError.js`; plan form; `QueueEntryCard`.
- **Ledger**: charge rows carry `meta.model` so cap spend can be rebuilt from the ledger.
- **Out of scope**: caps on image-count plans (`kind='image'`), per-account or per-key caps, model tiers/tags, snapshotting caps into purchases, and a customer-facing notice before a cap is reached.
