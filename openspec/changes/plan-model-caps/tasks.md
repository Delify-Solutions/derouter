## 1. Pure rules
- [x] 1.1 `src/lib/billing/modelCaps.js`: normalize, validate, serialize, match, describe, evaluate one cap
## 2. Schema and plans
- [x] 2.1 `plans.modelCaps`, `userPlanCapSpend`, `SCHEMA_VERSION` 39
- [x] 2.2 `billingRepo`: row mapping, validation (incl. unknown models), create/update
## 3. Queue
- [x] 3.1 `listQueueSync` loads caps and spend; `evaluatePlan(entry, now, model)`
- [x] 3.2 `admitSync` verdict `model_cap`; `chargeSync` pass 1 room; `applyTake` counters and `meta.model`
- [x] 3.3 `rebuildCapSpendSync`; `queueViewSync` exposes caps
## 4. Enforcement
- [x] 4.1 `keyEnforcement` + `platformError` map `model_cap`
## 5. UI
- [x] 5.1 Plan form section "Giới hạn riêng theo model"
- [x] 5.2 Queue card bar per cap (customer)
## 6. Tests
- [x] 6.1 Engine: admission, charging, windowed cap, rebuild consistency, validation
- [x] 6.2 Full suite, lint, build
