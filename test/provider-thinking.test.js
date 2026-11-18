// The admin's per-provider Thinking setting (Providers page):
//   Auto  → the client's own thinking goes through untouched;
//   level → that level is FORCED, whatever the client's CLI sent;
//   Off   → thinking is switched off.
// chatCore turns the setting into the "model(level)" suffix, which the translator already
// treats as the top-priority instruction. These tests pin both halves: the mapping from the
// stored setting to the suffix, and what the translator then writes for real providers.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/alias-hook.mjs", import.meta.url);

const { translateRequest } = await import("../open-sse/translator/index.js");
const { FORMATS } = await import("../open-sse/translator/formats.js");
const { providerThinkingSuffix, withThinkingSuffix, clampThinkingLevel, cloneThinkingBearing } = await import("../open-sse/translator/concerns/thinkingUnified.js");
const THINKING_LEVELS = await import("../open-sse/providers/thinkingLevels.js");

test("the stored setting maps to a suffix; Auto and junk map to none", () => {
  assert.equal(providerThinkingSuffix("auto"), null);
  assert.equal(providerThinkingSuffix({ mode: "auto" }), null);
  assert.equal(providerThinkingSuffix(undefined), null);
  assert.equal(providerThinkingSuffix(null), null);
  assert.equal(providerThinkingSuffix({ mode: "" }), null);
  assert.equal(providerThinkingSuffix({ mode: "not-a-level" }), null);
  assert.equal(providerThinkingSuffix({ mode: "off" }), "none");
  assert.equal(providerThinkingSuffix({ mode: "none" }), "none");
  for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.equal(providerThinkingSuffix({ mode: level }), level);
  }
  assert.equal(providerThinkingSuffix({ mode: " HIGH " }), "high");
  // an older stored value
  assert.equal(providerThinkingSuffix({ mode: "on" }), "medium");
  // the single "on" level of the on/off formats (zai, minimax)
  assert.equal(providerThinkingSuffix({ mode: "thinking" }), "medium");
});

test("the forced suffix replaces one the client put on the model", () => {
  assert.equal(withThinkingSuffix("claude-sonnet-4-5", "high"), "claude-sonnet-4-5(high)");
  assert.equal(withThinkingSuffix("claude-sonnet-4-5(low)", "max"), "claude-sonnet-4-5(max)");
  assert.equal(withThinkingSuffix("claude-sonnet-4-5(low)", null), "claude-sonnet-4-5(low)", "Auto leaves the model alone");
});

const run = (src, dst, model, body, provider) =>
  translateRequest(src, dst, model, structuredClone(body), true, { apiKey: "k" }, provider, null, [], "conn", null, false);

const CLAUDE_CODE = { model: "m", max_tokens: 4000, stream: true, thinking: { type: "enabled", budget_tokens: 12000 }, messages: [{ role: "user", content: "hi" }] };
const OPENAI_CLI = { model: "m", stream: true, reasoning_effort: "high", messages: [{ role: "user", content: "hi" }] };

test("Claude provider: Auto keeps the client's budget; a level overrides it; Off disables", () => {
  const model = "claude-sonnet-4-5";
  const auto = run(FORMATS.CLAUDE, FORMATS.CLAUDE, model, CLAUDE_CODE, "claude");
  assert.deepEqual(auto.thinking, { type: "enabled", budget_tokens: 12000 });

  const low = run(FORMATS.CLAUDE, FORMATS.CLAUDE, `${model}(low)`, CLAUDE_CODE, "claude");
  assert.equal(low.thinking.type, "enabled");
  assert.equal(low.thinking.budget_tokens, 1024, "forced low replaces the client's 12000");

  const max = run(FORMATS.CLAUDE, FORMATS.CLAUDE, `${model}(max)`, CLAUDE_CODE, "claude");
  assert.ok(max.thinking.budget_tokens > 12000, "forced max replaces the client's 12000");

  const off = run(FORMATS.CLAUDE, FORMATS.CLAUDE, `${model}(none)`, CLAUDE_CODE, "claude");
  assert.deepEqual(off.thinking, { type: "disabled" });
});

test("an OpenAI-shaped CLI is overridden the same way", () => {
  const model = "claude-sonnet-4-5";
  const auto = run(FORMATS.OPENAI, FORMATS.CLAUDE, model, OPENAI_CLI, "claude");
  assert.equal(auto.thinking.budget_tokens, 24576, "the client's high is kept");
  assert.equal(run(FORMATS.OPENAI, FORMATS.CLAUDE, `${model}(low)`, OPENAI_CLI, "claude").thinking.budget_tokens, 1024);
  assert.deepEqual(run(FORMATS.OPENAI, FORMATS.CLAUDE, `${model}(none)`, OPENAI_CLI, "claude").thinking, { type: "disabled" });
});

// The Responses translation leaves the effort as `reasoning_effort` (the codex executor moves it
// into `reasoning.effort`); either spelling counts.
const effortOf = (body) => body.reasoning_effort ?? body.reasoning?.effort;

test("Codex (Responses): the forced level beats the client's effort; Off is 'none'", () => {
  const model = "gpt-5.5";
  const auto = run(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, model, OPENAI_CLI, "codex");
  assert.equal(effortOf(auto), "high");
  assert.equal(effortOf(run(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, `${model}(low)`, OPENAI_CLI, "codex")), "low");
  assert.equal(effortOf(run(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, `${model}(low)`, CLAUDE_CODE, "codex")), "low");
  assert.equal(effortOf(run(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, `${model}(none)`, OPENAI_CLI, "codex")), "none");
});

test("Command Code: the forced level replaces the client's; Off sends \"off\"; the model id stays clean", () => {
  const model = "deepseek/deepseek-v4.1-flash";
  const cc = (src, m, body) => run(src, FORMATS.COMMANDCODE, m, body, "commandcode");
  const auto = cc(FORMATS.OPENAI, model, OPENAI_CLI);
  assert.equal(auto.params.reasoning_effort, "high");
  assert.equal(auto.params.model, model);
  for (const [src, body] of [[FORMATS.OPENAI, OPENAI_CLI], [FORMATS.CLAUDE, CLAUDE_CODE]]) {
    for (const level of ["max", "low", "none"]) {
      const out = cc(src, `${model}(${level})`, body);
      // regression: the envelope's params.model carried "…(none)" and Command Code rejected
      // every request of a provider whose Thinking was set
      assert.equal(out.params.model, model, `params.model for (${level})`);
    }
    assert.equal(cc(src, `${model}(max)`, body).params.reasoning_effort, "max");
    assert.equal(cc(src, `${model}(low)`, body).params.reasoning_effort, "low");
    // Off is "off" on the wire, as the official CLI sends it (omitting it lets the model think)
    const off = cc(src, `${model}(none)`, body);
    assert.equal(off.params.reasoning_effort, "off");
    assert.equal(off.thinking, undefined);
  }
});

test("Command Code: each model only gets an effort its catalog entry lists", () => {
  const cc = (m) => run(FORMATS.OPENAI, FORMATS.COMMANDCODE, m, OPENAI_CLI, "commandcode").params;
  // deepseek-v4.1-flash lists off/low/high/max: medium and xhigh move to the nearest
  assert.equal(cc("deepseek/deepseek-v4.1-flash(medium)").reasoning_effort, "low");
  assert.equal(cc("deepseek/deepseek-v4.1-flash(xhigh)").reasoning_effort, "high");
  // GLM-5.3 on Command Code cannot switch off (low/high/max): Off becomes its lowest level
  assert.equal(cc("zai-org/GLM-5.3(none)").reasoning_effort, "low");
  assert.equal(cc("zai-org/GLM-5.2(none)").reasoning_effort, "high");
  // a model whose catalog has no "off": its lowest listed level, never "off"
  assert.equal(cc("claude-sonnet-5-5(none)").reasoning_effort, "low");
  // models that were missing from the first table, and catalog aliases
  assert.equal(cc("meta/muse-spark-1.2(none)").reasoning_effort, "low");
  assert.equal(cc("meta/muse-spark-1.2(max)").reasoning_effort, "xhigh", "muse-spark-1.2 lists up to xhigh");
  assert.equal(cc("minimax/minimax-m3.1-flash:free(none)").reasoning_effort !== undefined, true);
  // a model not in the catalog: Off says nothing, as before
  assert.equal(cc("some/unlisted-model(none)").reasoning_effort, undefined);
});

test("Command Code in Auto: a client's own value is mapped to what the model accepts", () => {
  const send = (model, body) => run(FORMATS.OPENAI, FORMATS.COMMANDCODE, model, body, "commandcode").params;
  // the CLI asks for medium; deepseek-v4.1-flash serves off/low/high/max
  assert.equal(send("deepseek/deepseek-v4.1-flash", { ...OPENAI_CLI, reasoning_effort: "medium" }).reasoning_effort, "low");
  // the CLI switches thinking off itself
  assert.equal(send("deepseek/deepseek-v4.1-flash", { ...OPENAI_CLI, reasoning_effort: "none" }).reasoning_effort, "off");
  // ...on a model that cannot: its lowest level
  assert.equal(send("zai-org/GLM-5.3", { ...OPENAI_CLI, reasoning_effort: "none" }).reasoning_effort, "low");
  // the cmc alias reads the same table
  const { getThinkingLevels } = THINKING_LEVELS;
  assert.deepEqual(getThinkingLevels("cmc", "deepseek/deepseek-v4.1-flash"), ["none", "low", "high", "max"]);
  assert.deepEqual(getThinkingLevels("commandcode", "zai-org/GLM-5.2"), ["high", "max"]);
});

test("the Command Code table keeps the catalog's every entry with an effort list", () => {
  const { COMMAND_CODE_EFFORTS } = THINKING_LEVELS;
  // 83 catalogued models with efforts + their aliases (CLI 1.91.0 / live catalog)
  assert.ok(Object.keys(COMMAND_CODE_EFFORTS).length >= 83);
  for (const [id, levels] of Object.entries(COMMAND_CODE_EFFORTS)) {
    assert.ok(levels.length > 0, id);
    for (const l of levels) assert.ok(["none", "low", "medium", "high", "xhigh", "max"].includes(l), `${id}: ${l}`);
  }
});

test("no target format embeds the model(level) suffix anywhere in the upstream body", () => {
  // chatCore replaces the top-level `model`; anything nested (an envelope's params.model, a
  // Kiro modelId…) must already be the clean id, or the upstream rejects the request.
  const suffixed = "some-model(none)";
  const bodies = {
    [FORMATS.OPENAI]: { model: "x", stream: true, reasoning_effort: "high", messages: [{ role: "user", content: "hi" }] },
    [FORMATS.CLAUDE]: { model: "x", max_tokens: 100, messages: [{ role: "user", content: "hi" }] },
  };
  for (const target of Object.values(FORMATS)) {
    for (const [source, body] of Object.entries(bodies)) {
      let out;
      try { out = run(source, target, suffixed, body, "openai"); } catch { continue; }
      if (!out || typeof out !== "object") continue;
      const { model: _topLevel, ...rest } = out;
      assert.ok(!JSON.stringify(rest).includes(suffixed), `${source} -> ${target} leaks the suffix`);
    }
  }
});

test("a forced level the model does not serve moves to the nearest one it does", () => {
  const deepseek = ["low", "high", "max"];
  assert.equal(clampThinkingLevel("high", deepseek), "high", "served: unchanged");
  assert.equal(clampThinkingLevel("medium", deepseek), "low", "equidistant-ish: nearer by budget, lower on a tie");
  assert.equal(clampThinkingLevel("xhigh", deepseek), "high");
  assert.equal(clampThinkingLevel("max", ["low", "high"]), "high");
  assert.equal(clampThinkingLevel("low", ["high", "max"]), "high");
  // never moved: Off, an unknown value, or a model with no known level list
  assert.equal(clampThinkingLevel("none", ["low"]), "none");
  assert.equal(clampThinkingLevel("xhigh", null), "xhigh");
  assert.equal(clampThinkingLevel("xhigh", []), "xhigh");
  assert.equal(clampThinkingLevel(null, ["low"]), null);
});

test("applying a level to a copy never touches the client's original body", () => {
  const original = {
    model: "m",
    request: { contents: [{ role: "user", parts: [{ text: "hi" }] }], generationConfig: { thinkingConfig: { thinkingBudget: 100 }, maxOutputTokens: 50 } },
    thinking: { type: "enabled", budget_tokens: 5000 },
    params: { reasoning_effort: "high" },
  };
  const snapshot = structuredClone(original);
  const copy = cloneThinkingBearing(original);
  // what applyThinking does: strip, then write
  delete copy.thinking;
  delete copy.params.reasoning_effort;
  delete copy.request.generationConfig.thinkingConfig;
  copy.request.generationConfig.maxOutputTokens = 9999;
  assert.deepEqual(original, snapshot, "the shared original is unchanged");
  assert.equal(copy.request.contents, original.request.contents, "messages are shared, not copied");
});
