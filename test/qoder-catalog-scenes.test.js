// Qoder's model list: the IDE reads the `chat` scene, the Qoder app/CLI (agent SDK 0.5.x) reads
// `assistant`, where newer models (DeepSeek, GLM) are published.
import { test } from "node:test";
import assert from "node:assert/strict";

const { parseQoderCatalog, routableQoderModels, seedQoderCatalogForTests, clearQoderCatalog } = await import("../open-sse/services/qoderModels.js");
const { __test__ } = await import("../open-sse/executors/qoder.js");

test("models from the assistant scene are listed next to the chat scene", () => {
  const out = parseQoderCatalog({
    chat: [{ key: "auto", display_name: "Auto" }, { key: "performance", display_name: "Performance" }],
    assistant: [
      { key: "auto", display_name: "Auto (assistant copy)" },
      { key: "deepseek-v4", display_name: "DeepSeek V4", max_input_tokens: 128000, is_reasoning: true },
      { key: "glm-5.3", display_name: "GLM 5.3" },
    ],
    quest: [{ key: "quest-only", display_name: "Quest" }],
    external_models: [{ key: "x/y", outer_provider: "x" }],
  });
  assert.deepEqual(out.models.map((m) => m.id), ["auto", "performance", "deepseek-v4", "glm-5.3"]);
  // the chat scene's entry wins for a shared key
  assert.equal(out.rawConfigs.get("auto").display_name, "Auto");
  assert.equal(out.rawConfigs.get("deepseek-v4").display_name, "DeepSeek V4");
  assert.equal(out.models[2].isReasoning, true);
  assert.equal(out.rawConfigs.has("quest-only"), false);
  assert.deepEqual(out.scenes, {
    chat: ["auto", "performance"],
    assistant: ["auto", "deepseek-v4", "glm-5.3"],
    quest: ["quest-only"],
    external_models: ["x/y"],
  });
  const routable = routableQoderModels(out).map((m) => m.id);
  assert.ok(routable.includes("deepseek-v4") && routable.includes("glm-5.3"));
});

test("an assistant-only catalog is accepted; no chat scene at all is not a catalog", () => {
  assert.deepEqual(parseQoderCatalog({ assistant: [{ key: "glm-5.3", display_name: "GLM" }] }).models.map((m) => m.id), ["glm-5.3"]);
  assert.equal(parseQoderCatalog({ quest: [] }), null);
  assert.equal(parseQoderCatalog(null), null);
  assert.equal(parseQoderCatalog([]), null);
  // the IDE-only shape keeps working
  assert.deepEqual(parseQoderCatalog({ chat: [{ key: "auto" }] }).models.map((m) => m.id), ["auto"]);
});

test("a chat request for an assistant-only model sends that entry as model_config", async () => {
  clearQoderCatalog();
  const credentials = {
    provider: "qoder",
    accessToken: "tok",
    providerSpecificData: { userId: "u-1", machineId: "m-1" },
  };
  const glm = { key: "glm-5.3", display_name: "GLM 5.3", source: "system", is_reasoning: true, max_input_tokens: 200000 };
  assert.ok(seedQoderCatalogForTests(credentials, { chat: [{ key: "auto", display_name: "Auto" }], assistant: [glm] }));
  const { payload } = await __test__.buildQoderRequestBody({
    model: "qoder/glm-5.3",
    body: { messages: [{ role: "user", content: "hi" }] },
    credentials,
  });
  assert.equal(payload.model_config.key, "glm-5.3");
  assert.equal(payload.model_config.display_name, "GLM 5.3");
  assert.equal(payload.model_config.source, "system");
  assert.equal(payload.model_config.max_input_tokens, 200000);
  clearQoderCatalog();
});
