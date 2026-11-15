## Why

The owner asked for two admin conveniences on combos:
- a **maintenance switch** per combo, so a model can be taken out of service without deleting it or editing every group allow-list;
- **quick price multipliers** (x0.5, x2, x3) on the combo price form, so a price is "pool price times N" without a calculator.

## What Changes

- **Combo maintenance**: `combos.meta.maintenance === true` marks a combo as under maintenance (no schema change; same `meta` blob as `cacheEstimation`). A request that names such a combo is refused by `enforceKeyLimits` with HTTP 503 `model_maintenance` before admission, so no plan credit is reserved and no upstream is called. A combo that lists a maintenance combo as a member skips that member like any unavailable member. Admin: a "Bảo trì" switch on each combo card (the combo form has no second switch). Customers: `/v1/models` keeps listing it with `maintenance: true`, and the model price tables (public usage page, account models page) show a "Bảo trì" label.
- **Price multipliers**: on the combo price form, buttons x0.5, x1, x2, x3 set every price field to the base price times the factor. The base is the pool price while the form still shows the auto-filled suggestion; for an image combo, a combo with a saved price or a price the admin typed, the base is the values in the form when the first button is pressed, so pressing x2 then x3 gives 3x, not 6x. Results use decimal arithmetic rounded to 6 places, never float drift.

## Capabilities

### Modified Capabilities
- `api-access-enforcement`: maintenance denial and listing flag.
- `customer-portal`: maintenance label on model price tables.

### New Capabilities
- `combo-pricing-admin`: the combo price form (auto-fill and multipliers).

## Impact

- No schema change, no `SCHEMA_VERSION` bump.
- New: `src/lib/combos/maintenance.js`, `scalePricingDraft` in `src/shared/utils/pricingMatch.js`.
- Changed: `keyEnforcement.js`, `platformError.js` (code + message), `/api/combos/[id]` PUT (validates and stores the flag), `getComboInfo`, `/v1/models`, `priceList.js`, combos page, model price table component.
