## Context

Today one thing decides which models a customer key may call: the account's group (`keyEnforcement.js`, step 6). A plan decides the unit and the ceiling of spending, nothing about models. So every plan a member of one group holds grants identical model access.

The owner wants a plan to decide *which models it includes*. Group membership cannot express that, because a customer holds several plans at once while belonging to exactly one group.

## Goals / Non-Goals

**Goals**
- A plan may restrict its purchases to a list of combos.
- Access is the group's list narrowed by the purchases' lists — never widened.
- The purchase that pays for a request is one that allows the requested model.
- What a customer paid for cannot change under them when an admin edits a plan, unless the admin explicitly pushes the change down.

**Non-Goals**
- Per-model *money* ceilings. That was `planModelLimits` (dropped by migration 006) and stays gone: a purchase is one credit pool with per-window limits.
- Per-model pricing per plan. Prices stay per combo.
- Editing one purchase's list by hand, diverging from its plan. The plan is the source; `applyToActive` is the only way to move existing purchases.

## Decisions

### D1 — The group is the account ceiling, the plan narrows

`group.allowedModels` stays the outermost bound, enforced first and unchanged. A plan list is then intersected with it. A plan that names a model the group denies grants nothing, so an admin can never widen a group's policy by editing a plan, and a group change still takes effect immediately for every plan the customer holds.

The alternative — letting a plan's list override the group — was rejected because it makes the group meaningless for anyone holding a restricted plan, and it would let an admin accidentally hand out a model the group exists to withhold.

### D2 — `null` means unrestricted, and that is what every existing plan becomes

`plans.allowedModels` is nullable. `null` = no restriction. Every plan created before this change reads `null` and therefore grants exactly what it grants today. This is what makes the change deployable without a migration of behaviour: a fresh column with only `NULL` values cannot narrow anything.

An empty array is refused at validation rather than stored: "allows nothing" is never intended, and a plan that silently grants nothing is a support ticket waiting to happen.

### D3 — Admission filters by model, and so does charging

`admitSync` gains the requested model and skips purchases that do not allow it. This is the obvious half.

The half that is easy to miss: `chargeSync` re-reads the queue at charge time (design D4 of plan-queue-billing — admission is never pinned) and walks it independently. Without the same filter, a `gpt-5` request admitted on plan B would be billed to plan A because plan A sits first in the queue. That is a money bug, not a display bug, and it is why the filter lives in `planModels.js` and is applied in both passes of both functions.

The charge call site passes `entry.requestedModel` (the combo the client called), which `saveRequestUsage` already receives. `requestedModel` is absent when the client sent a provider-qualified id; in that case the purchase is treated as unrestricted for the filter, because refusing to bill a request that already ran would be worse than billing it.

### D4 — An ineligible purchase is not "blocked"

Admission distinguishes "no plan can pay" (402) from "every plan is window-blocked" (429, with a reopen time). A purchase that does not allow this model must not feed the 429 path: telling a customer to wait an hour for a window that would then refuse them anyway is a lie. So the filter runs **before** the blocked/eligible evaluation and drops the entry entirely.

### D5 — Snapshot on the order and the purchase, `applyToActive` to move it

`orders` and `userPlans` get their own `allowedModels`, like `limits`, `kind` and `rpm`. A paid order grants the list that was on sale when it was created, and an admin edit does not reach it.

Changing live purchases is a separate, explicit action, matching how `applyToActive` already works for limits: `PATCH /api/plans/[id]` with `applyToActive: true` rewrites the snapshots and writes one audit entry per purchase. The admin form shows how many live purchases would lose access before saving, because removing a model from a plan someone is mid-period on is the one edit with a customer-visible cost.

### D6 — The effective set for a listing is the union over live purchases

`/v1/models` and every screen that advertises models must show what the customer can actually call: the union of the live purchases' lists (or "everything the group allows" when any live purchase is unrestricted), intersected with the group.

A customer with **no** live purchase keeps the group's full list. Showing nothing would make a fresh account look broken, and the honest answer for a request is 402 (no quota), not 403 (no access) — those are different problems and the error code says which.

### D7 — One pure module

`src/lib/billing/planModels.js` holds `normalizePlanModels`, `planAllowsModel`, `unionOfModels`, `modelsRestrictionOf`. Pure, no driver. Admission, charging, enforcement, the four listing call sites and the admin form all import it, so the rule "a plan narrows, never widens" exists in exactly one place and cannot drift between the request path and the screen that advertises it.

Matching reuses `matchesAllowed` from `auth/modelMatching.js`, the same function the group list uses, so a combo name, a provider-prefixed id and a dated id collapse the same way in both lists.

## Risks / Trade-offs

- **A request can now be refused with 403 where it used to be charged.** That is the feature, but it means an operator who sets a list on a plan that live customers hold, without `applyToActive`, creates a split: new buyers get the restriction, existing ones do not. The form states this before saving.
- **`requestedModel` can be missing** (a provider-qualified id). Those requests are billed without the model filter. Accepting that gap is deliberate: the alternative is refusing to bill a completed request. The combo-name path, which is what customers call (spec model-privacy restricts customer keys to combo names anyway), always carries it.
- **Two lookups per request** (the queue with its model filter, then the effective set for the listing) are reads of rows each path already selects — no extra query on the chat path, one extra `SELECT` on `/v1/models`.

## Migration Plan

`SCHEMA_VERSION` 37 → 38 so `migrate.js` takes its pre-change backup. The sync is additive: three nullable columns, no row rewritten. Every existing plan reads `allowedModels = NULL`, so behaviour after the upgrade is identical to before it — including for an installation that never uses the feature.

Rollback: the previous image reads the extra columns as unused, so a downgrade needs only the older tag.

## Open Questions

None remaining. The one worth recording: whether an admin should be able to hand-edit a single purchase's list. Decided no (D1/D5) — one source of truth, and the audit trail stays meaningful.
