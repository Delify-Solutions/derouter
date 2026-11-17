## Decisions

**D1 — Read live from the plan.** Caps are looked up through `userPlans.planId → plans.modelCaps` in `listQueueSync`, like `rpm`/`tpm`. Snapshotting (as `allowedModels` and `limits` do) would need a column on `orders` and `userPlans` plus changes in checkout, grants, gifts, affiliate wallet and the apply-to-active action. A cap is a tuning knob the owner adjusts after launch, so applying to everyone at once is the wanted behaviour. A purchase without a plan (gift, admin grant) has no caps. Revisit if the owner needs caps frozen at sale time.

**D2 — Counters live per purchase, keyed by cap id.** `userPlanCapSpend(userPlanId, capId)`. A whole-term cap (`hours` null) keeps one row whose `startedAt` is the first charge and never closes; a windowed cap opens at the first charge and resets when its window closes, exactly like `userPlanWindows`. Changing a cap's `max` or models keeps its spend; removing a cap orphans its rows (ignored).

**D3 — A cap blocks a model, not the purchase.** `evaluatePlan(entry, now, model)` reports `capBlocked` for the requested model only. A cap-blocked purchase stays eligible for other models. The purchase is *not* `blocked` in the window sense, so it never produces the 429 `plan_limit` reopen time.

**D4 — Denial code.** A purchase can pay for the model again only when *every* block on it lifts: the later of its window reopening and its cap reopening, and never when the cap is whole-term. Verdict for the request: if some purchase is blocked only by something that does reopen, 429 `plan_limit` with the earliest such time (as before). Otherwise, when a purchase is blocked by a cap alone, or by a window *and* a whole-term cap, 429 `model_cap` with the cap's label; `resetAt` is the earliest windowed reopen and absent for a whole-term cap (waiting would not help; the message says the cap is used up). A window-blocked purchase therefore never promises a reopen time that a permanent cap would still refuse.

**D5 — Charging respects caps in pass 1, not pass 2.** Same rule as windows: an admitted request is always paid, so pass 2 (ignoring windows) also ignores caps and the spend is still recorded, which blocks the next request.

**D6 — Matching.** A cap applies to a request when `matchesAllowed(model, cap.models)` (the matcher groups and plans use). A model in several caps is subject to all of them and counts in each. A request without a known model matches no cap.

**D7 — Only credit plans.** Caps are refused on image plans (the `kind` is compared through `isImagePlan`, so case and padding do not matter) (their unit is images, and an image purchase cannot pay dollars). `hours` is null (whole term) or an integer ≥ 1; 0, "" and fractions are refused, never coerced. Caps are allowed on unlimited-credit plans: the cap is then the only bound on that model group.

**D8 — Rebuildable.** Charge ledger rows record `meta.model`; `rebuildCapSpendSync` replays them with the same open/close rule, which is what the consistency test asserts against the live counters.
