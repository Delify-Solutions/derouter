## Context

RPM/TPM are already counted per user across all keys (`api-access-enforcement`), at the rate of the plan at the head of the queue. Pinning a key means the "paying plan" of a request can differ per key, so one per-user counter no longer says whose allowance is being spent.

## Decisions

**D1 — Allowance scope is (user, plan).** Counters are the trailing-60s `usageHistory` rows of the user's keys whose `ratePlanId` equals the plan. Alternatives considered: one counter per user with the pinned plan's limit (simple, but a cheap and a premium plan would fight over one counter), and per-key counters (the bypass this change exists to prevent). The scope key is `plans.id`, not `userPlans.id`, so repeated purchases of one plan share an allowance.

**D2 — `ratePlanId` is stamped when usage is saved**, in the same transaction as the usage row: the key's pinned plan, else the plan of the purchase `admitSync` would pick at that instant. No plumbing through the SSE handlers; the pin is read from `apiKeys` by id (not from the 60 s owner cache) so a change applies to the next request. Denied requests are stamped the same way, so they keep counting toward RPM exactly as before. A race between enforcement and save (queue head changes in between) can attribute one request to the neighbouring plan; accepted.

**D3 — Pinned means exclusive.** `admitSync` and `chargeSync` filter the queue through `scopeQueue(queue, planId)`. A shortfall in `chargeSync` becomes debt as it does for an unpinned user, never a spill onto another plan. A 429 `plan_limit` still reports the reopen time of the pinned plan's windows.

**D4 — Only plans the customer holds can be chosen** (`status = 'active'` and unexpired purchase). A key whose plan later lapses keeps its pin, answers 402 with the plan's name, and the key list shows "Gói hết hạn" so the customer can renew or move it. No automatic fallback.

**D5 — Additive schema**, no versioned migration: `planId`/`ratePlanId` are nullable, NULL meaning "all plans" / "no plan allowance".
