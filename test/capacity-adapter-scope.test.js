// Vision Adapter scope and declared capabilities (spec capacity-adapter
// "Adapter scope").
import { test } from "node:test";
import assert from "node:assert/strict";

const { augmentModelsWithCapacityAdapter, adapterCoversModel } = await import("../open-sse/services/capacityAdapter.js");

const VISION = new Set(["vision"]);
// "oc/mimo-v2.5-free" is vision-capable in the capability table; "x/deepseek-chat" is not.
const NO_VISION = ["x/deepseek-chat"];
const settings = (vision) => ({ capacityAdapter: { vision: { enabled: true, roundRobin: false, models: ["oc/mimo-v2.5-free"], ...vision } } });

test("scope all: a model without vision gets the adapter in front (unchanged behaviour)", () => {
  const out = augmentModelsWithCapacityAdapter(NO_VISION, VISION, settings({}), { requestedModel: "Cheap" });
  assert.deepEqual(out, ["oc/mimo-v2.5-free", ...NO_VISION]);
});

test("a combo that declares vision is never adapted", () => {
  const out = augmentModelsWithCapacityAdapter(NO_VISION, VISION, settings({}), {
    requestedModel: "DeepSeek-V4.1-Flash",
    declaredCaps: { vision: true },
  });
  assert.deepEqual(out, NO_VISION);
});

test("scope selected: only the listed requested models are adapted", () => {
  const s = settings({ scope: "selected", targets: ["Cheap"] });
  assert.deepEqual(augmentModelsWithCapacityAdapter(NO_VISION, VISION, s, { requestedModel: "Cheap" })[0], "oc/mimo-v2.5-free");
  assert.deepEqual(augmentModelsWithCapacityAdapter(NO_VISION, VISION, s, { requestedModel: "Other" }), NO_VISION);
  assert.deepEqual(augmentModelsWithCapacityAdapter(NO_VISION, VISION, s, {}), NO_VISION, "no name, no adapter");
});

test("scope selected with no targets adapts nothing; a disabled adapter covers nothing", () => {
  assert.equal(adapterCoversModel("vision", settings({ scope: "selected", targets: [] }), "Cheap"), false);
  assert.equal(adapterCoversModel("vision", settings({ enabled: false }), "Cheap"), false);
  assert.equal(adapterCoversModel("vision", settings({}), null), true);
});

test("legacy settings without scope keep adapting everything", () => {
  const legacy = { capacityAdapter: { vision: [{ model: "oc/mimo-v2.5-free", enabled: true }] } };
  assert.equal(augmentModelsWithCapacityAdapter(NO_VISION, VISION, legacy)[0], "oc/mimo-v2.5-free");
});

test("a request needing no hard capability is untouched", () => {
  assert.deepEqual(augmentModelsWithCapacityAdapter(NO_VISION, new Set(["tools"]), settings({})), NO_VISION);
});
