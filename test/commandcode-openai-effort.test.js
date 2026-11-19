// An OpenAI-compatible node pointed at Command Code's OpenAI API (/provider/v1) must send efforts
// in Command Code's own enum (off|low|medium|high|xhigh|max). OpenAI's "none", "minimal" and
// "auto" are refused there with 400 "Invalid option".
import test from "node:test";
import assert from "node:assert/strict";

const efforts = await import("../open-sse/services/commandcodeEfforts.js");
const { toCommandCodeEffort, commandCodeOpenAIBody, isCommandCodeUrl, stripThinkingSuffix, forcedThinkingLevel } =
  await import("../open-sse/translator/concerns/thinkingUnified.js");
const { getExecutor } = await import("../open-sse/executors/index.js");
const { translateRequest } = await import("../open-sse/translator/index.js");

const CC_ENUM = new Set(["off", "low", "medium", "high", "xhigh", "max"]);
const CC_BASE = "https://api.commandcode.ai/provider/v1";

// A fresh live catalog, so the executor's background refresh never goes to the network.
const CATALOG = {
  refreshAfterSeconds: 86400,
  data: [
    { id: "deepseek/deepseek-v4.1-flash", reasoningEfforts: ["off", "low", "high", "max"] },
    { id: "zai-org/GLM-5.3", reasoningEfforts: ["low", "high", "max"] },
    { id: "moonshotai/Kimi-K2.6", reasoningEfforts: null },
    { id: "Qwen/Qwen4-Max", reasoningEfforts: ["off", "low", "high", "xhigh"] },
    { id: "deepseek/deepseek-v4-flash-fast", reasoningEfforts: ["off", "low", "high", "max"] },
  ],
};
test.beforeEach(() => {
  efforts.resetCommandCodeCatalogForTests();
  efforts.setCommandCodeCatalog(CATALOG);
});

// The request pipeline for a node: translateRequest (thinking applied there), then chatCore's
// model rewrite, then the executor.
function viaNode({ src = "openai", body, model, compat = false, forced = false, apiType = "chat", baseUrl = CC_BASE }) {
  const provider = apiType === "responses" ? "openai-compatible-responses-t" : "openai-compatible-chat-t";
  const target = apiType === "responses" ? "openai-responses" : "openai";
  const creds = { apiKey: "k", providerSpecificData: { baseUrl, apiType }, compatNormalization: compat, _thinkingOverride: forced };
  const translated = translateRequest(src, target, model, structuredClone(body), true, creds, provider, null, [], null, null, compat);
  translated.model = stripThinkingSuffix(model);
  return getExecutor(provider).transformRequest(stripThinkingSuffix(model), translated, true, creds);
}
const chat = (model, extra = {}) => ({ model, messages: [{ role: "user", content: "hi" }], stream: true, ...extra });

test("toCommandCodeEffort: catalogued model gets only the levels it lists", () => {
  const m = "deepseek/deepseek-v4.1-flash"; // off | low | high | max
  assert.equal(toCommandCodeEffort("none", m), "off");
  assert.equal(toCommandCodeEffort("off", m), "off");
  assert.equal(toCommandCodeEffort("minimal", m), "low");
  assert.equal(toCommandCodeEffort("medium", m), "low");
  assert.equal(toCommandCodeEffort("auto", m), "high");
  // Nearest listed level; on a tie the lower one (existing clamp rule).
  assert.equal(toCommandCodeEffort("xhigh", m), "high");
  assert.equal(toCommandCodeEffort("ultra", m), "max");
  assert.equal(toCommandCodeEffort("HIGH", m), "high");
});

test("toCommandCodeEffort: no effort list, cannot switch off, uncatalogued", () => {
  assert.equal(toCommandCodeEffort("high", "moonshotai/Kimi-K2.6"), null);
  // GLM-5.3 lists low|high|max without off: off becomes its lowest level.
  assert.equal(toCommandCodeEffort("none", "zai-org/GLM-5.3"), "low");
  // Uncatalogued: "none" is left out, OpenAI-only values are mapped, enum values pass.
  assert.equal(toCommandCodeEffort("none", "vendor/unknown"), null);
  assert.equal(toCommandCodeEffort("minimal", "vendor/unknown"), "low");
  assert.equal(toCommandCodeEffort("auto", "vendor/unknown"), "high");
  assert.equal(toCommandCodeEffort("xhigh", "vendor/unknown"), "xhigh");
  assert.equal(toCommandCodeEffort("whatever", "vendor/unknown"), null);
  assert.equal(toCommandCodeEffort("", "vendor/unknown"), null);
  assert.equal(toCommandCodeEffort(undefined, "vendor/unknown"), null);
});

test("isCommandCodeUrl matches only Command Code hosts", () => {
  assert.equal(isCommandCodeUrl(`${CC_BASE}/chat/completions`), true);
  assert.equal(isCommandCodeUrl("https://commandcode.ai/x"), true);
  assert.equal(isCommandCodeUrl("https://api.commandcode.ai.evil.com/v1"), false);
  assert.equal(isCommandCodeUrl("https://notcommandcode.ai/v1"), false);
  assert.equal(isCommandCodeUrl("not a url"), false);
  assert.equal(isCommandCodeUrl("https://api.commandcode.ai./provider/v1"), true);
  assert.equal(isCommandCodeUrl("https://commandcode.ai@evil.com/v1"), false);
});

test("commandCodeOpenAIBody maps Chat and Responses shapes without mutating the input", () => {
  const chat = { model: "deepseek/deepseek-v4.1-flash", reasoning_effort: "none" };
  const outChat = commandCodeOpenAIBody(chat, chat.model);
  assert.equal(outChat.reasoning_effort, "off");
  assert.equal(chat.reasoning_effort, "none");

  const resp = { model: "deepseek/deepseek-v4.1-flash", reasoning: { effort: "minimal", summary: "auto" } };
  const outResp = commandCodeOpenAIBody(resp, resp.model);
  assert.deepEqual(outResp.reasoning, { effort: "low", summary: "auto" });
  assert.equal(resp.reasoning.effort, "minimal");

  const noEffort = { model: "moonshotai/Kimi-K2.6", reasoning_effort: "high" };
  assert.equal("reasoning_effort" in commandCodeOpenAIBody(noEffort, noEffort.model), false);

  const untouched = { model: "deepseek/deepseek-v4.1-flash", reasoning_effort: "high" };
  assert.equal(commandCodeOpenAIBody(untouched, untouched.model), untouched);
});

test("an OpenAI-compatible node at Command Code never sends an effort outside its enum", () => {
  const ex = getExecutor("openai-compatible-chat-test");
  const creds = { apiKey: "k", providerSpecificData: { baseUrl: CC_BASE } };
  for (const model of ["deepseek/deepseek-v4.1-flash", "zai-org/GLM-5.3", "moonshotai/Kimi-K2.6", "vendor/unknown"]) {
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]) {
      const body = { model, messages: [{ role: "user", content: "hi" }], stream: true, reasoning_effort: effort };
      const out = ex.transformRequest(model, body, true, creds);
      if (out.reasoning_effort !== undefined) {
        assert.ok(CC_ENUM.has(out.reasoning_effort), `${model} ${effort} -> ${out.reasoning_effort}`);
      }
      assert.equal(body.reasoning_effort, effort, "client body is not mutated");
    }
  }
  // The request from the bug report: Claude Code's helper sends reasoning_effort "none".
  const out = ex.transformRequest("deepseek/deepseek-v4.1-flash",
    { model: "deepseek/deepseek-v4.1-flash", messages: [], stream: true, reasoning_effort: "none" }, true, creds);
  assert.equal(out.reasoning_effort, "off");
});

test("Responses-type node at Command Code maps reasoning.effort", () => {
  const ex = getExecutor("openai-compatible-responses-test");
  const creds = { apiKey: "k", providerSpecificData: { baseUrl: CC_BASE, apiType: "responses" } };
  const out = ex.transformRequest("deepseek/deepseek-v4.1-flash",
    { model: "deepseek/deepseek-v4.1-flash", input: "hi", stream: true, reasoning: { effort: "none" } }, true, creds);
  assert.equal(out.reasoning.effort, "off");
});

test("a node at any other OpenAI-compatible host keeps OpenAI efforts", () => {
  const ex = getExecutor("openai-compatible-chat-test");
  const creds = { apiKey: "k", providerSpecificData: { baseUrl: "https://api.example.com/v1" } };
  for (const effort of ["none", "minimal", "auto"]) {
    const out = ex.transformRequest("m", { model: "m", messages: [], stream: true, reasoning_effort: effort }, true, creds);
    assert.equal(out.reasoning_effort, effort);
  }
});

test("native Command Code provider keeps producing enum values (shared mapping)", () => {
  const body = { model: "deepseek/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }], reasoning_effort: "none" };
  const none = translateRequest("openai", "commandcode", body.model, structuredClone(body), true, {}, "commandcode");
  assert.equal(none.params.reasoning_effort, "off");
  const forced = translateRequest("openai", "commandcode", "deepseek/deepseek-v4.1-flash(minimal)", structuredClone(body), true, { _thinkingOverride: true }, "commandcode");
  assert.equal(forced.params.reasoning_effort, "low");
  const kimi = translateRequest("openai", "commandcode", "moonshotai/Kimi-K2.6(high)", { ...structuredClone(body), model: "moonshotai/Kimi-K2.6" }, true, { _thinkingOverride: true }, "commandcode");
  assert.equal(kimi.params.reasoning_effort, undefined);
});

test("pipeline: forced Off, compat and Claude clients all reach Command Code as its own effort", () => {
  const m = "deepseek/deepseek-v4.1-flash";
  // Forced Off on the node (strict mode): the suffix path.
  let out = viaNode({ body: chat(m), model: `${m}(none)`, forced: true });
  assert.equal(out.reasoning_effort, "off");
  assert.equal(out.thinking, undefined, "no deepseek-style thinking object");
  // Compat mode with the client's "none".
  out = viaNode({ body: chat(m, { reasoning_effort: "none" }), model: m, compat: true });
  assert.equal(out.reasoning_effort, "off");
  assert.equal(out.thinking, undefined);
  // A Claude-format client switching thinking off.
  out = viaNode({ src: "claude", body: { model: m, max_tokens: 50, messages: [{ role: "user", content: "hi" }], thinking: { type: "disabled" } }, model: m });
  assert.equal(out.reasoning_effort, "off");
  assert.equal(out.thinking, undefined);
  // A Claude-format client with adaptive thinking: auto → high.
  out = viaNode({ src: "claude", body: { model: m, max_tokens: 50, messages: [{ role: "user", content: "hi" }], thinking: { type: "adaptive" } }, model: m });
  assert.equal(out.reasoning_effort, "high");
});

test("pipeline: catalog decides, not the model family's own thinking shape", () => {
  // GLM: auto → high (the zai shape would have sent max).
  let out = viaNode({ body: chat("zai-org/GLM-5.3"), model: "zai-org/GLM-5.3(auto)", forced: true });
  assert.equal(out.reasoning_effort, "high");
  // Qwen: an effort, never enable_thinking / thinking_budget.
  out = viaNode({ body: chat("Qwen/Qwen4-Max", { reasoning_effort: "medium" }), model: "Qwen/Qwen4-Max", compat: true });
  assert.equal(out.reasoning_effort, "low");
  assert.equal(out.enable_thinking, undefined);
  assert.equal(out.thinking_budget, undefined);
  // A model without an effort list gets none, even when a level is forced.
  out = viaNode({ body: chat("moonshotai/Kimi-K2.6"), model: "moonshotai/Kimi-K2.6(high)", forced: true });
  assert.equal(out.reasoning_effort, undefined);
  // Responses-type node: forced Off as reasoning.effort.
  out = viaNode({ body: { model: "deepseek/deepseek-v4.1-flash", input: "hi", stream: true }, model: "deepseek/deepseek-v4.1-flash(none)", forced: true, apiType: "responses" });
  assert.equal(out.reasoning?.effort, "off");
  assert.equal(out.reasoning_effort, undefined);
});

test("pipeline: every effort and every path stays in Command Code's enum", () => {
  const models = ["deepseek/deepseek-v4.1-flash", "zai-org/GLM-5.3", "moonshotai/Kimi-K2.6", "Qwen/Qwen4-Max", "vendor/unknown"];
  const values = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "auto", "ultra"];
  for (const model of models) for (const compat of [false, true]) {
    for (const effort of values) {
      const a = viaNode({ body: chat(model, { reasoning_effort: effort }), model, compat });
      const b = viaNode({ body: chat(model), model: `${model}(${effort})`, compat, forced: true });
      for (const out of [a, b]) {
        if (out.reasoning_effort !== undefined) assert.ok(CC_ENUM.has(out.reasoning_effort), `${model} ${effort} compat=${compat} -> ${out.reasoning_effort}`);
        for (const k of ["thinking", "enable_thinking", "thinking_budget", "reasoning"]) assert.equal(out[k], undefined, `${model} ${effort} carries ${k}`);
      }
    }
  }
});

test("native Command Code: ultra becomes the model's top listed level", () => {
  const body = { model: "deepseek/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] };
  const out = translateRequest("openai", "commandcode", "deepseek/deepseek-v4.1-flash(ultra)", structuredClone(body), true, { _thinkingOverride: true }, "commandcode");
  assert.equal(out.params.reasoning_effort, "max");
});

test("forced level on a Command Code node is clamped against Command Code's catalog (chatCore step)", () => {
  const node = { providerSpecificData: { baseUrl: CC_BASE } };
  const p = "openai-compatible-chat-t";
  // The deepseek family's guessed levels would have turned Low into high.
  assert.equal(forcedThinkingLevel({ mode: "low" }, p, "deepseek/deepseek-v4-flash-fast", node), "low");
  assert.equal(forcedThinkingLevel({ mode: "xhigh" }, p, "Qwen/Qwen4-Max", node), "xhigh");
  assert.equal(forcedThinkingLevel({ mode: "off" }, p, "deepseek/deepseek-v4-flash-fast", node), "none");
  assert.equal(forcedThinkingLevel({ mode: "auto" }, p, "deepseek/deepseek-v4-flash-fast", node), null);
  // End to end from the forced level: the upstream gets what the native provider would send.
  const level = forcedThinkingLevel({ mode: "low" }, p, "deepseek/deepseek-v4-flash-fast", node);
  const out = viaNode({ body: chat("deepseek/deepseek-v4-flash-fast"), model: `deepseek/deepseek-v4-flash-fast(${level})`, forced: true });
  assert.equal(out.reasoning_effort, "low");
  // Same forced level for the native provider.
  assert.equal(forcedThinkingLevel({ mode: "low" }, "commandcode", "deepseek/deepseek-v4-flash-fast"), "low");
});
