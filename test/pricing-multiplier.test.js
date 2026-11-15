// Quick price multipliers and the maintenance flag helpers (spec combo-pricing-admin,
// api-access-enforcement). Pure functions: no database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scalePrice, scalePricingDraft, PRICE_FACTORS } from "../src/shared/utils/pricingMatch.js";
import { comboIsInMaintenance, isValidMaintenanceInput, withMaintenance } from "../src/lib/combos/maintenance.js";

test("x2, x3 and x0.5 multiply exactly", () => {
  assert.equal(scalePrice("3", 2), "6");
  assert.equal(scalePrice("15", 3), "45");
  assert.equal(scalePrice("3", 0.5), "1.5");
  assert.equal(scalePrice("0.75", 2), "1.5");
});

test("no float drift: 0.1 x 3 is 0.3", () => {
  assert.equal(scalePrice("0.1", 3), "0.3");
  assert.equal(scalePrice("0.07", 3), "0.21");
  assert.equal(scalePrice(1.1, 3), "3.3");
});

test("x1 restores the base and results are rounded half up to 6 places", () => {
  assert.equal(scalePrice("2.5", 1), "2.5");
  assert.equal(scalePrice("0.000003", 0.5), "0.000002");
  assert.equal(scalePrice("0.000001", 0.5), "0.000001");
});

test("empty and invalid values stay as they are", () => {
  assert.equal(scalePrice("", 2), "");
  assert.equal(scalePrice(null, 2), null);
  assert.equal(scalePrice("abc", 2), "abc");
  assert.equal(scalePrice("-1", 2), "-1");
});

test("a draft is scaled from the base every time, so presses do not compound", () => {
  const base = { input: "0.1", output: "", cached: "3", reasoning: "", cache_creation: "", image: "" };
  const x2 = scalePricingDraft(base, 2);
  const x3 = scalePricingDraft(base, 3);
  assert.deepEqual(x2, { input: "0.2", output: "", cached: "6", reasoning: "", cache_creation: "", image: "" });
  assert.equal(x3.input, "0.3");
  assert.deepEqual(scalePricingDraft(base, 1), { ...base, input: "0.1", cached: "3" });
});

test("the offered factors are 0.5, 1, 2, 3", () => {
  assert.deepEqual(PRICE_FACTORS, [0.5, 1, 2, 3]);
});

test("maintenance flag: only an explicit true counts", () => {
  assert.equal(comboIsInMaintenance({ meta: { maintenance: true } }), true);
  for (const meta of [{}, null, undefined, { maintenance: false }, { maintenance: "true" }, { maintenance: 1 }]) {
    assert.equal(comboIsInMaintenance({ meta }), false);
  }
  assert.equal(comboIsInMaintenance(null), false);
});

test("maintenance input validation and meta patch", () => {
  assert.equal(isValidMaintenanceInput(undefined), true);
  assert.equal(isValidMaintenanceInput(true), true);
  assert.equal(isValidMaintenanceInput(false), true);
  assert.equal(isValidMaintenanceInput("true"), false);
  assert.equal(isValidMaintenanceInput(1), false);
  assert.deepEqual(withMaintenance({ capabilities: { vision: true } }, true), { capabilities: { vision: true }, maintenance: true });
  assert.deepEqual(withMaintenance({ maintenance: true, cacheEstimation: true }, false), { cacheEstimation: true });
  assert.deepEqual(withMaintenance(null, false), {});
});

import { pickPriceBase } from "../src/shared/utils/pricingMatch.js";

test("base: the pool price only while the form still shows the auto-filled suggestion", () => {
  const pool = { input: "3" }; const current = { input: "9" };
  assert.equal(pickPriceBase({ pool, current }), pool);
});

test("base: a saved, typed or image price is never replaced by a pool price", () => {
  const pool = { input: "3", image: "0.5" }; const current = { input: "9", image: "0.04" };
  assert.equal(pickPriceBase({ pool, current, touched: true }), current, "saved or edited price");
  assert.equal(pickPriceBase({ pool, current, isImage: true }), current, "image combo");
  assert.equal(pickPriceBase({ pool: null, current }), current, "no pool price to fill from");
});

test("base: a base captured at an earlier press wins, so presses do not compound", () => {
  const captured = { input: "3" };
  assert.equal(pickPriceBase({ captured, pool: { input: "5" }, current: { input: "6" }, touched: true }), captured);
});
