## 1. Price multipliers
- [x] 1.1 `scalePricingDraft(base, factor)` in `pricingMatch.js` (decimal-safe) + tests
- [x] 1.2 Buttons on the combo price form; base tracking; marks the price as touched ← (verify: x2 then x3 gives 3x; x1 restores the base; empty fields stay empty)

## 2. Maintenance
- [x] 2.1 `src/lib/combos/maintenance.js` (`comboIsInMaintenance`, `withMaintenance`, input validation) + tests
- [x] 2.2 `/api/combos/[id]` PUT stores the flag; `/api/combos` list returns it; `getComboInfo` exposes it
- [x] 2.3 `enforceKeyLimits` refuses with 503 `model_maintenance` after the allow-list, before admission; platform error code + Vietnamese message ← (verify: no credit reserved, history row with status 503, admin key refused too, keyless request not refused)
- [x] 2.4 Nested member skipped as unavailable
- [x] 2.5 `/v1/models` `maintenance: true`; price list `maintenance` flag; "Bảo trì" label on customer tables
- [x] 2.6 Admin switch on the combo card

## 3. Checks
- [x] 3.1 `npm test`, lint, build; merge deltas into `openspec/specs/` on archive
