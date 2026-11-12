## Why

A customer's API keys are all interchangeable: whichever plan is at the head of the queue pays for every key. A customer who holds several plans (say a cheap fast-rate plan and a premium one) cannot dedicate one key to one plan, e.g. a production key on the premium plan and a scratch key on the cheap one. At the same time the owner does not want minting more keys to become a way around RPM/TPM.

## What Changes

- A customer key can be **pinned to one plan** or left on **all plans** (today's behaviour). Chosen when creating the key and changeable later on `/account/keys`.
- A pinned key is admitted and charged by purchases of that plan alone, in their normal queue order. It never falls back to another plan: with no live purchase of the plan the request is 402 `insufficient_quota`, with a message that names the plan.
- RPM/TPM follow the plan and are counted **per (user, plan)**, shared by every key paid by that plan (pinned to it, or unpinned while it is at the head of the queue). A second key never opens a second allowance; a second plan keeps its own allowance. Buying the same plan twice does not double it (the allowance is keyed on `plans.id`, not on the purchase).
- Platform messages for RPM/TPM now say "của gói" instead of "của nhóm" (rates have lived on plans since `billing-v2-plan-queue`).

## Capabilities

### Modified Capabilities
- `api-access-enforcement`: customer rates are counted per (user, plan); new requirement for keys pinned to a plan.
- `customer-portal`: the API key page shows and edits the plan of each key.

## Impact

- **Code**: `src/lib/billing/planQueue.js` (`admitSync`/`chargeSync` take `planId`, new `scopeQueue`, `ratePlanIdSync`), `src/lib/auth/keyEnforcement.js`, `src/lib/auth/platformError.js`, `src/lib/db/repos/{apiKeysRepo,usageRepo,accountPlansRepo}.js`, `src/app/api/account/keys/**`, `src/app/account/keys/components/KeysPageClient.js`.
- **Database**: `apiKeys.planId`, `usageHistory.ratePlanId`; `SCHEMA_VERSION` 20 → 21 (additive, no migration). Existing keys stay on "all plans". Usage rows written before this release have no `ratePlanId`, so they stop counting toward a plan's allowance: for at most one minute after upgrade a customer's recent requests are not seen.
- **API**: `GET /api/account/keys` adds `planId`, `planName`, `planHeld` per key and a top-level `plans`; `POST` accepts `planId`; new `PATCH /api/account/keys/[id]`.
- **Out of scope**: admin keys (no plan queue), pinning to a plan the customer does not hold, per-key limits, an admin screen for key pinning.
