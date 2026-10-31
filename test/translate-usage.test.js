// Usage mapping in every translation direction (spec usage-accuracy), plus the non-stream
// response translation's content rules (spec proxy-transparency).
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/alias-hook.mjs", import.meta.url);

const { initState } = await import("../open-sse/translator/index.js");
const { claudeToOpenAIResponse } = await import("../open-sse/translator/response/claude-to-openai.js");
const { openaiToClaudeResponse } = await import("../open-sse/translator/response/openai-to-claude.js");
const { openaiToOpenAIResponsesResponse, openaiResponsesToOpenAIResponse } = await import("../open-sse/translator/response/openai-responses.js");
const { openaiToAntigravityResponse } = await import("../open-sse/translator/response/openai-to-antigravity.js");
const { kiroToClaudeResponse, kiroToClaudeNonStreaming } = await import("../open-sse/translator/response/kiro-to-claude.js");
const { geminiToOpenAIResponse } = await import("../open-sse/translator/response/gemini-to-openai.js");
const { responsesUsageFromChat, toOpenAIUsage } = await import("../open-sse/translator/concerns/usage.js");
const { translateNonStreamingResponse } = await import("../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { FORMATS } = await import("../open-sse/translator/formats.js");

const CHAT_USAGE = { prompt_tokens: 4511, completion_tokens: 20, total_tokens: 4531, prompt_tokens_details: { cached_tokens: 4480, cache_creation_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 8 } };
const finishChunk = (usage) => ({ id: "chatcmpl-abcdef123456", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...(usage ? { usage } : {}) });
const textChunk = (content) => ({ id: "chatcmpl-abcdef123456", model: "m", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] });

// ── Anthropic stream -> OpenAI chunks ──────────────────────────────────────

test("Claude to OpenAI (stream): prompt_tokens = input + cache read + cache write, details report the cache", () => {
  const state = initState(FORMATS.OPENAI);
  claudeToOpenAIResponse({ type: "message_start", message: { id: "msg_1", model: "m", usage: { input_tokens: 31, output_tokens: 1, cache_read_input_tokens: 4000, cache_creation_input_tokens: 480 } } }, state);
  const out = claudeToOpenAIResponse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } }, state);
  assert.deepEqual(out.at(-1).usage, {
    prompt_tokens: 4511, completion_tokens: 20, total_tokens: 4531,
    prompt_tokens_details: { cached_tokens: 4000, cache_creation_tokens: 480 },
  });
});

test("Claude to OpenAI (stream): a stream ending at message_stop reports the same figures", () => {
  const state = initState(FORMATS.OPENAI);
  claudeToOpenAIResponse({ type: "message_start", message: { id: "msg_1", model: "m", usage: { input_tokens: 31, output_tokens: 1, cache_read_input_tokens: 4480 } } }, state);
  const out = claudeToOpenAIResponse({ type: "message_stop" }, state);
  assert.equal(out.at(-1).usage.prompt_tokens, 4511);
  assert.equal(out.at(-1).usage.prompt_tokens_details.cached_tokens, 4480);
});

// ── OpenAI chunks -> Anthropic stream ──────────────────────────────────────

test("OpenAI to Claude (stream): input_tokens excludes the cache, which gets its own fields", () => {
  const state = initState(FORMATS.CLAUDE);
  openaiToClaudeResponse(textChunk("Hi"), state);
  const out = openaiToClaudeResponse(finishChunk(CHAT_USAGE), state);
  const delta = out.find((e) => e.type === "message_delta");
  assert.deepEqual(delta.usage, { input_tokens: 31, output_tokens: 20, cache_read_input_tokens: 4480 });
  // the Claude client's own sum equals the upstream's prompt
  assert.equal(delta.usage.input_tokens + delta.usage.cache_read_input_tokens, CHAT_USAGE.prompt_tokens);
});

test("OpenAI to Claude (stream): cache writes are reported as cache_creation_input_tokens", () => {
  const state = initState(FORMATS.CLAUDE);
  openaiToClaudeResponse(textChunk("Hi"), state);
  const out = openaiToClaudeResponse(finishChunk({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 40, cache_creation_tokens: 10 } }), state);
  assert.deepEqual(out.find((e) => e.type === "message_delta").usage, { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 40, cache_creation_input_tokens: 10 });
});

test("OpenAI to Claude (stream): without upstream usage the required field is a zeroed placeholder", () => {
  const state = initState(FORMATS.CLAUDE);
  openaiToClaudeResponse(textChunk("Hi"), state);
  const out = openaiToClaudeResponse(finishChunk(null), state);
  assert.deepEqual(out.find((e) => e.type === "message_delta").usage, { input_tokens: 0, output_tokens: 0 });
});

// ── OpenAI chunks -> Responses events ──────────────────────────────────────

test("OpenAI to Responses (stream): response.completed carries usage with cached and reasoning details", () => {
  const state = initState(FORMATS.OPENAI_RESPONSES);
  openaiToOpenAIResponsesResponse(textChunk("Hi"), state);
  const events = openaiToOpenAIResponsesResponse(finishChunk(CHAT_USAGE), state);
  const completed = events.find((e) => e.event === "response.completed");
  assert.deepEqual(completed.data.response.usage, {
    input_tokens: 4511, output_tokens: 20, total_tokens: 4531,
    input_tokens_details: { cached_tokens: 4480 },
    output_tokens_details: { reasoning_tokens: 8 },
  });
});

test("OpenAI to Responses (stream): no upstream usage means no usage field", () => {
  const state = initState(FORMATS.OPENAI_RESPONSES);
  openaiToOpenAIResponsesResponse(textChunk("Hi"), state);
  const events = openaiToOpenAIResponsesResponse(finishChunk(null), state);
  assert.equal("usage" in events.find((e) => e.event === "response.completed").data.response, false);
});

test("responsesUsageFromChat maps every field and nothing else", () => {
  assert.equal(responsesUsageFromChat(null), null);
  assert.deepEqual(responsesUsageFromChat({ prompt_tokens: 10, completion_tokens: 2 }), { input_tokens: 10, output_tokens: 2, total_tokens: 12 });
  assert.deepEqual(responsesUsageFromChat({ input_tokens: 10, output_tokens: 2, total_tokens: 99 }), { input_tokens: 10, output_tokens: 2, total_tokens: 99 });
});

// ── Responses events -> OpenAI chunks ──────────────────────────────────────

test("Responses to OpenAI (stream): input_tokens already includes the cached part and is not added to", () => {
  const state = initState(FORMATS.OPENAI);
  state.started = true; state.chatId = "chatcmpl-x";
  const chunk = openaiResponsesToOpenAIResponse({ type: "response.completed", response: { usage: { input_tokens: 200, output_tokens: 30, total_tokens: 230, input_tokens_details: { cached_tokens: 150 }, output_tokens_details: { reasoning_tokens: 12 } } } }, state);
  assert.deepEqual(chunk.usage, {
    prompt_tokens: 200, completion_tokens: 30, total_tokens: 230,
    prompt_tokens_details: { cached_tokens: 150 },
    completion_tokens_details: { reasoning_tokens: 12 },
  });
});

// ── OpenAI chunks -> Gemini / Antigravity ──────────────────────────────────

test("OpenAI to Gemini (stream): usageMetadata carries cached and thinking counts", () => {
  const state = {};
  openaiToAntigravityResponse(textChunk("Hi"), state);
  const out = openaiToAntigravityResponse(finishChunk(CHAT_USAGE), state);
  assert.deepEqual(out.response.usageMetadata, {
    promptTokenCount: 4511, candidatesTokenCount: 20, totalTokenCount: 4531, thoughtsTokenCount: 8, cachedContentTokenCount: 4480,
  });
});

// ── Gemini chunks -> OpenAI chunks ─────────────────────────────────────────

test("Gemini to OpenAI (stream): thinking tokens are completion, the prompt is the prompt", () => {
  const state = initState(FORMATS.OPENAI);
  const out = geminiToOpenAIResponse({ response: { candidates: [{ content: { parts: [{ text: "Hi" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: 5, totalTokenCount: 35, cachedContentTokenCount: 4 } } }, state);
  const usage = out.at(-1).usage;
  assert.equal(usage.prompt_tokens, 10);
  assert.equal(usage.completion_tokens, 25);
  assert.equal(usage.total_tokens, 35);
  assert.equal(usage.prompt_tokens_details.cached_tokens, 4);
  assert.equal(usage.completion_tokens_details.reasoning_tokens, 5);
});

// ── Kiro -> Claude ─────────────────────────────────────────────────────────

test("Kiro to Claude: a chat-shaped prompt that includes the cache is split the Anthropic way", () => {
  const state = initState(FORMATS.CLAUDE);
  kiroToClaudeResponse(textChunk("Hi"), state);
  const out = kiroToClaudeResponse(finishChunk({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 60 } }), state);
  assert.deepEqual(out.find((e) => e.type === "message_delta").usage, { input_tokens: 40, output_tokens: 5, cache_read_input_tokens: 60 });
  const nonStream = kiroToClaudeNonStreaming({ choices: [{ message: { content: "x" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 60 } } });
  assert.deepEqual(nonStream.usage, { input_tokens: 40, output_tokens: 5, cache_read_input_tokens: 60 });
});

// ── non-stream: provider body -> client body ───────────────────────────────

test("non-stream Claude upstream to an OpenAI client: usage folds the cache in", () => {
  const body = { id: "msg_1", type: "message", model: "m", content: [{ type: "text", text: "Hi" }], stop_reason: "end_turn", usage: { input_tokens: 31, output_tokens: 7, cache_read_input_tokens: 4000, cache_creation_input_tokens: 480 } };
  const out = translateNonStreamingResponse(body, FORMATS.CLAUDE, FORMATS.OPENAI);
  assert.deepEqual(out.usage, { prompt_tokens: 4511, completion_tokens: 7, total_tokens: 4518, prompt_tokens_details: { cached_tokens: 4000, cache_creation_tokens: 480 } });
});

test("non-stream OpenAI upstream to a Claude client: input_tokens excludes the cache", () => {
  const body = { id: "chatcmpl-1", model: "m", choices: [{ message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }], usage: CHAT_USAGE };
  const out = translateNonStreamingResponse(body, FORMATS.OPENAI, FORMATS.CLAUDE);
  assert.deepEqual(out.usage, { input_tokens: 31, output_tokens: 20, cache_read_input_tokens: 4480 });
});

test("non-stream OpenAI upstream to a Responses client: cached and reasoning details are kept", () => {
  const body = { id: "chatcmpl-1", model: "m", choices: [{ message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }], usage: CHAT_USAGE };
  const out = translateNonStreamingResponse(body, FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES);
  assert.deepEqual(out.usage, { input_tokens: 4511, output_tokens: 20, total_tokens: 4531, input_tokens_details: { cached_tokens: 4480 }, output_tokens_details: { reasoning_tokens: 8 } });
});

test("non-stream Gemini upstream to an OpenAI client: thinking is output, not prompt", () => {
  const body = { candidates: [{ content: { parts: [{ text: "Hi" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: 5, totalTokenCount: 35, cachedContentTokenCount: 4 } };
  const out = translateNonStreamingResponse(body, FORMATS.GEMINI, FORMATS.OPENAI);
  assert.equal(out.usage.prompt_tokens, 10, "was 15: thinking used to be added to the prompt");
  assert.equal(out.usage.completion_tokens, 25);
  assert.equal(out.usage.prompt_tokens_details.cached_tokens, 4);
});

test("non-stream Claude upstream: the model's own code fences are returned untouched unless compat is on", () => {
  const body = { id: "msg_1", type: "message", model: "m", content: [{ type: "text", text: "```json\n{\"a\":1}\n```" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
  assert.equal(translateNonStreamingResponse(structuredClone(body), FORMATS.CLAUDE, FORMATS.OPENAI).choices[0].message.content, "```json\n{\"a\":1}\n```");
  assert.equal(translateNonStreamingResponse(structuredClone(body), FORMATS.CLAUDE, FORMATS.OPENAI, null, { compat: true }).choices[0].message.content, "{\"a\":1}");
});

test("toOpenAIUsage keeps the cache split for Anthropic and the thinking split for Gemini", () => {
  assert.deepEqual(toOpenAIUsage({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 }, "claude"), { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, prompt_tokens_details: { cached_tokens: 3 } });
  assert.deepEqual(toOpenAIUsage({ promptTokenCount: 5, candidatesTokenCount: 2, thoughtsTokenCount: 1, totalTokenCount: 8 }, "gemini"), { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8, completion_tokens_details: { reasoning_tokens: 1 } });
});
