// Request side of proxy transparency (spec proxy-transparency): with the same format on both
// sides and compatNormalization off, the client's body is forwarded as sent.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/alias-hook.mjs", import.meta.url);

const { translateRequest } = await import("../open-sse/translator/index.js");
const { FORMATS } = await import("../open-sse/translator/formats.js");
const { DefaultExecutor } = await import("../open-sse/executors/default.js");
const { stripUnsupportedParams } = await import("../open-sse/translator/concerns/paramSupport.js");
const { injectReasoningContent } = await import("../open-sse/utils/reasoningContentInjector.js");

const clone = (o) => structuredClone(o);
const run = (src, dst, body, compat = false, provider = "openai-compatible-chat-x", model = "some-model") =>
  translateRequest(src, dst, model, body, true, { apiKey: "k" }, provider, null, [], "conn", null, compat);

const OPENAI_BODY = {
  model: "some-model",
  stream: true,
  reasoning_effort: "high",
  temperature: 0.2,
  messages: [
    { role: "developer", content: "be brief" },
    { role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }, { type: "image_url", image_url: { url: "https://example.com/a.png" } }] },
    { role: "assistant", content: null, tool_calls: [{ id: "call:1", function: { name: "f", arguments: { a: 1 } } }] },
    { role: "user", content: "   " },
    { role: "assistant", content: "ok", reasoning_content: "thinking..." },
  ],
  tools: [{ type: "function", function: { name: "f", parameters: { type: "object", properties: {} } } }],
};

test("OpenAI to OpenAI, strict: the body is forwarded exactly as the client sent it", () => {
  const body = clone(OPENAI_BODY);
  const out = run(FORMATS.OPENAI, FORMATS.OPENAI, body);
  assert.deepEqual(out, OPENAI_BODY);
  assert.deepEqual(Object.keys(out), Object.keys(OPENAI_BODY), "field order is kept");
});

test("OpenAI to OpenAI, compat: the legacy normalisation runs", () => {
  const out = run(FORMATS.OPENAI, FORMATS.OPENAI, clone(OPENAI_BODY), true);
  assert.equal(out.messages[0].role, "system", "developer becomes system");
  assert.equal(out.messages.some((m) => m.content === "   "), false, "blank message dropped");
  assert.notEqual(out.messages[2].tool_calls[0].id, "call:1", "tool id rewritten");
  assert.equal(out.messages.some((m) => m.role === "tool"), true, "a missing tool response is invented");
});

test("Claude to Claude, strict: cache_control breakpoints, max_tokens and tools are the client's own", () => {
  const body = {
    model: "some-model",
    max_tokens: 100_000,
    stream: true,
    thinking: { type: "enabled", budget_tokens: 5000 },
    system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }, { type: "text", text: "more" }],
    messages: [
      { role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "t", input: {} }] },
    ],
    tools: [{ type: "web_search_20250305", name: "web_search" }, { name: "t", input_schema: { type: "object" } }],
  };
  const out = run(FORMATS.CLAUDE, FORMATS.CLAUDE, clone(body), false, "anthropic-compatible-x");
  assert.deepEqual(out, body);
});

test("Claude to Claude, compat: cache breakpoints are rewritten and max_tokens clamped, as before", () => {
  const body = {
    model: "some-model", max_tokens: 100_000, stream: true,
    system: [{ type: "text", text: "sys" }, { type: "text", text: "more" }],
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  };
  const out = run(FORMATS.CLAUDE, FORMATS.CLAUDE, clone(body), true, "anthropic-compatible-x");
  assert.equal(out.system.at(-1).cache_control.ttl, "1h");
  assert.ok(out.max_tokens < 100_000);
});

test("Responses to Responses, strict: reasoning and input are untouched", () => {
  const body = { model: "some-model", stream: true, reasoning: { effort: "high", summary: "auto" }, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }], store: false };
  const out = run(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSES, clone(body), false, "openai-compatible-responses-x");
  assert.deepEqual(out, body);
});

test("a real format conversion still translates and normalises", () => {
  const claude = { model: "some-model", max_tokens: 50, stream: true, system: "sys", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };
  const out = run(FORMATS.CLAUDE, FORMATS.OPENAI, claude);
  assert.equal(out.messages[0].role, "system");
  assert.equal(out.messages.at(-1).role, "user");
  assert.equal(out.system, undefined);
});

test("the model(level) suffix is still honoured in strict mode: it is not part of the upstream id", () => {
  const mk = () => ({ model: "x", messages: [{ role: "user", content: "hi" }] });
  const withSuffix = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, "gpt-5(high)", mk(), true, { apiKey: "k" }, "openai", null, [], "c", null, false);
  assert.equal(withSuffix.reasoning_effort, "high");
  const without = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, "gpt-5", mk(), true, { apiKey: "k" }, "openai", null, [], "c", null, false);
  assert.deepEqual(without, mk());
});

// ── executor shims ─────────────────────────────────────────────────────────

test("json_schema is forwarded as is unless compat is on", () => {
  const ex = new DefaultExecutor("openai-compatible-chat-abc");
  const body = { model: "m", messages: [{ role: "system", content: "s" }], response_format: { type: "json_schema", json_schema: { name: "n", schema: { type: "object" } } } };
  assert.deepEqual(ex.transformRequest("m", clone(body), false, { compatNormalization: false }), body);
  const compat = ex.transformRequest("m", clone(body), false, { compatNormalization: true });
  assert.equal(compat.response_format.type, "json_object");
  assert.match(compat.messages[0].content, /JSON schema/);
});

test("the model-name rules do not rewrite assistant turns sent to a custom node", () => {
  const ex = new DefaultExecutor("openai-compatible-chat-abc");
  const body = { model: "deepseek-v4", messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }], temperature: 0.3 };
  assert.deepEqual(ex.transformRequest("deepseek-v4", clone(body), false, { compatNormalization: false }), body);
  const compat = ex.transformRequest("deepseek-v4", clone(body), false, { compatNormalization: true });
  assert.equal(compat.messages[1].reasoning_content, " ");
  // a registry provider keeps the injection it declares
  assert.equal(injectReasoningContent({ provider: "deepseek", model: "deepseek-chat", body: clone(body), compat: false }).messages[1].reasoning_content, " ");
});

test("temperature is dropped for claude-* only where legacy shaping runs (built-ins), not on a custom node", () => {
  const b1 = { temperature: 0.5, messages: [] };
  stripUnsupportedParams("openai-compatible-chat-x", "claude-sonnet-4", b1, { compat: false });
  assert.equal(b1.temperature, 0.5);
  const b2 = { temperature: 0.5, messages: [] };
  stripUnsupportedParams("openrouter", "claude-sonnet-4", b2, { compat: true });
  assert.equal(b2.temperature, undefined);
});

test("the include_usage addition is the only change to a streamed chat body", () => {
  const ex = new DefaultExecutor("openai-compatible-chat-abc");
  const body = clone(OPENAI_BODY);
  const out = ex.transformRequest("some-model", body, true, { compatNormalization: false, providerSpecificData: { apiType: "chat" } });
  const { stream_options, ...rest } = out;
  assert.deepEqual(stream_options, { include_usage: true });
  assert.deepEqual(rest, OPENAI_BODY);
});

// ── cross-format conversions keep what the target can express ──────────────

test("OpenAI to Claude, strict: the client's max_tokens is kept and no identity prompt is injected", () => {
  const body = { model: "m", max_tokens: 4096, stream: true, messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "f", parameters: { type: "object", properties: {} } } }] };
  const out = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "m", clone(body), true, { apiKey: "plain-key" }, "anthropic-compatible-x", null, [], "c", null, false);
  assert.equal(out.max_tokens, 4096, "was raised to 32000 because tools were present");
  assert.deepEqual(out.system.map((b) => b.text), ["be brief"], "no 'You are Claude Code' block");
  const oauth = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "m", clone(body), true, { accessToken: "sk-ant-oat01-x" }, "claude", null, [], "c", null, false);
  assert.ok(oauth.system.some((b) => /Claude Code/.test(b.text)), "an OAuth credential needs it");
  const compat = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "m", clone(body), true, { apiKey: "plain-key", compatNormalization: true }, "anthropic-compatible-x", null, [], "c", null, true);
  assert.equal(compat.max_tokens, 32000);
  assert.ok(compat.system.some((b) => /Claude Code/.test(b.text)));
});

test("OpenAI to Claude: Anthropic requires max_tokens, so only then is a default supplied", () => {
  const out = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "m", { model: "m", messages: [{ role: "user", content: "hi" }] }, true, { apiKey: "k" }, "anthropic-compatible-x", null, [], "c", null, false);
  assert.equal(out.max_tokens, 64000);
  const out2 = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "m", { model: "m", max_completion_tokens: 1234, messages: [{ role: "user", content: "hi" }] }, true, { apiKey: "k" }, "anthropic-compatible-x", null, [], "c", null, false);
  assert.equal(out2.max_tokens, 1234);
});

test("Claude to OpenAI, strict: a large max_tokens is not clamped", () => {
  const out = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI, "m", { model: "m", max_tokens: 100_000, messages: [{ role: "user", content: "hi" }] }, true, { apiKey: "k" }, "openai-compatible-chat-x", null, [], "c", null, false);
  assert.equal(out.max_tokens, 100_000);
  const small = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI, "m", { model: "m", max_tokens: 100, messages: [{ role: "user", content: "hi" }], tools: [{ name: "t", input_schema: { type: "object" } }] }, true, { apiKey: "k" }, "openai-compatible-chat-x", null, [], "c", null, false);
  assert.equal(small.max_tokens, 100);
});

// ── canned replies and Claude Code shaping ─────────────────────────────────

const { handleBypassRequest } = await import("../open-sse/utils/bypassHandler.js");
const { isCustomNodeProvider } = await import("../open-sse/utils/transparency.js");

test("a Claude Code warmup request is sent to the upstream, not answered by the router, unless compat is on", () => {
  const body = { model: "m", stream: false, messages: [{ role: "user", content: [{ type: "text", text: "Warmup" }] }] };
  assert.equal(handleBypassRequest(body, "m", "claude-cli/2.0"), null);
  assert.equal(handleBypassRequest(body, "m", "claude-cli/2.0", false, { compat: false }), null);
  assert.ok(handleBypassRequest(body, "m", "claude-cli/2.0", false, { compat: true }), "legacy canned reply");
});

test("the ccFilterNaming option stays its own opt-in", () => {
  const body = { model: "m", stream: false, system: "decide isNewTopic", messages: [{ role: "user", content: "hello" }] };
  assert.equal(handleBypassRequest(body, "m", "claude-cli/2.0", false), null);
  assert.ok(handleBypassRequest(body, "m", "claude-cli/2.0", true));
});

test("custom nodes are told apart from built-in providers", () => {
  assert.equal(isCustomNodeProvider("anthropic-compatible-abc"), true);
  assert.equal(isCustomNodeProvider("openai-compatible-chat-abc"), true);
  assert.equal(isCustomNodeProvider("claude"), false);
  assert.equal(isCustomNodeProvider(undefined), false);
});

// ── built-in providers keep their shaping in default mode ──────────────────

const CLAUDE_TO_MINIMAX = {
  model: "MiniMax-M2", max_tokens: 5_000_000, stream: true,
  system: [{ type: "text", text: "sys" }, { type: "text", text: "more" }],
  messages: [{ role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] }],
  tools: [{ name: "t", input_schema: { type: "object" } }],
};

test("Claude body to a built-in Claude-format provider (MiniMax) is still prepared by default", () => {
  const creds = { apiKey: "k" };
  const out = translateRequest(FORMATS.CLAUDE, FORMATS.CLAUDE, "MiniMax-M2", clone(CLAUDE_TO_MINIMAX), true, creds, "minimax", null, [], "c", null, false);
  assert.equal(out.system.at(-1).cache_control.ttl, "1h", "cache breakpoints re-anchored");
  assert.equal(out.messages[0].content[0].cache_control, undefined, "client breakpoint rewritten");
  assert.ok(out.max_tokens < 5_000_000, "clamped to the model ceiling");
  assert.equal(creds.compatNormalization, true, "executors and request translators see the legacy-shaping flag");
  // the same body to a custom node is forwarded as sent
  const custom = translateRequest(FORMATS.CLAUDE, FORMATS.CLAUDE, "MiniMax-M2", clone(CLAUDE_TO_MINIMAX), true, { apiKey: "k" }, "anthropic-compatible-x", null, [], "c", null, false);
  assert.deepEqual(custom, CLAUDE_TO_MINIMAX);
});

test("a built-in OpenAI-format provider still gets the OpenAI normalisation by default", () => {
  const out = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, "gpt-4o", clone(OPENAI_BODY), true, { apiKey: "k" }, "deepseek", null, [], "c", null, false);
  assert.equal(out.messages[0].role, "system", "developer mapped to system");
  assert.equal(out.messages.some((m) => m.role === "tool"), true, "missing tool response inserted");
});

test("a built-in provider keeps the legacy max_tokens policy and identity prompt on conversion", () => {
  const body = { model: "m", max_tokens: 4096, stream: true, messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "f", parameters: { type: "object", properties: {} } } }] };
  const out = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "m", clone(body), true, { apiKey: "plain" }, "minimax", null, [], "c", null, false);
  assert.equal(out.max_tokens, 32000);
  assert.ok(out.system.some((b) => /Claude Code/.test(b.text)));
});

test("built-in Kimi keeps the reasoning_content injection by default; a custom node serving kimi does not", () => {
  const body = { model: "kimi-k2", messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] }] };
  const builtin = new DefaultExecutor("kimi").transformRequest("kimi-k2", clone(body), false, { compatNormalization: false });
  assert.equal(builtin.messages[1].reasoning_content, " ");
  const custom = new DefaultExecutor("openai-compatible-chat-x").transformRequest("kimi-k2", clone(body), false, { compatNormalization: false });
  assert.equal(custom.messages[1].reasoning_content, undefined);
});

test("built-in provider keeps name-keyed parameter stripping (claude-* temperature) in default mode", () => {
  const ex = new DefaultExecutor("openrouter");
  assert.equal(ex.transformRequest("anthropic/claude-sonnet-4", { model: "x", temperature: 0.4, messages: [] }, false, { compatNormalization: false }).temperature, undefined);
  const custom = new DefaultExecutor("openai-compatible-chat-x");
  assert.equal(custom.transformRequest("claude-sonnet-4", { model: "x", temperature: 0.4, messages: [] }, false, { compatNormalization: false }).temperature, 0.4);
});

test("the admin thinking override is mapped to the upstream's own field even in strict mode", () => {
  // providerThinking "on" wrote a Claude-style `thinking` into an OpenAI-format body
  const body = { model: "gpt-5", stream: true, messages: [{ role: "user", content: "hi" }], thinking: { type: "enabled", budget_tokens: 10000 } };
  const withOverride = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, "gpt-5", clone(body), true, { apiKey: "k", _thinkingOverride: true }, "openai-compatible-chat-x", null, [], "c", null, false);
  assert.equal(withOverride.thinking, undefined, "no top-level `thinking` to an OpenAI-format upstream");
  assert.ok(withOverride.reasoning_effort, "mapped to reasoning_effort");
  // a client-sent field without an override stays exactly as sent
  const clientSent = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, "gpt-5", clone(body), true, { apiKey: "k" }, "openai-compatible-chat-x", null, [], "c", null, false);
  assert.deepEqual(clientSent, body);
  // reasoning_effort override to an Anthropic upstream
  const eff = { model: "m", max_tokens: 100, messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" };
  const out = translateRequest(FORMATS.CLAUDE, FORMATS.CLAUDE, "claude-sonnet-4-5", clone(eff), true, { apiKey: "k", _thinkingOverride: true }, "anthropic-compatible-x", null, [], "c", null, false);
  assert.equal(out.reasoning_effort, undefined, "no reasoning_effort to an Anthropic upstream");
});
