// Usage accuracy (spec usage-accuracy): which figures are recorded, billed and shown.
// Pure functions first; the stream-level scenarios live in test/stream-transparency.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/alias-hook.mjs", import.meta.url);

const {
  mergeUsage, pickRecordedUsage, claudeUsageFromOpenAI, estimateUsage, estimateInputTokens, estimateOutputTokens,
  hasValidUsage, canonicalizeUsage, extractUsage, filterUsageForFormat,
} = await import("../open-sse/utils/usageTracking.js");
const { costFromTokensNano } = await import("../src/shared/utils/money.js");
const { extractUsageFromResponse, usageOrEstimate } = await import("../open-sse/handlers/chatCore/requestDetail.js");
const usageModule = await import("../open-sse/utils/usageTracking.js");

const REAL = { prompt_tokens: 4511, completion_tokens: 2, total_tokens: 4513, prompt_tokens_details: { cached_tokens: 4480 } };

// ── no safety margin anywhere ──────────────────────────────────────────────

test("the +2000 buffer is gone: nothing exports or applies it", () => {
  assert.equal(usageModule.addBufferToUsage, undefined);
  const est = estimateUsage({ messages: [{ role: "user", content: "hello world" }] }, "abcd");
  assert.equal(est.prompt_tokens, 3, "11 ASCII characters at 4 per token, no margin");
  assert.equal(est.completion_tokens, 1);
  assert.equal(est.total_tokens, 4);
  assert.equal(est.estimated, true);
  const claude = estimateUsage({ messages: [{ role: "user", content: "hello world" }] }, "abcd", "claude");
  assert.deepEqual(claude, { input_tokens: 3, output_tokens: 1, estimated: true });
});

test("the estimate does not count JSON syntax or base64 payloads as text", () => {
  const png = "A".repeat(400_000);
  const body = { messages: [{ role: "user", content: [{ type: "text", text: "describe" }, { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } }] }] };
  const tokens = estimateInputTokens(body);
  assert.equal(tokens, 2 + 1000, "8 text characters plus one flat media item, not 100k tokens of base64");
  const anthropic = { messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png } }] }] };
  assert.equal(estimateInputTokens(anthropic), 1000);
});

test("the estimate treats non-ASCII text as denser than English", () => {
  assert.equal(estimateOutputTokens("a".repeat(40)), 10);
  assert.equal(estimateOutputTokens("ế".repeat(40)), 20);
  assert.equal(estimateOutputTokens(0), 0);
  assert.equal(estimateOutputTokens({ ascii: 3, wide: 0 }), 1);
});

test("the estimated flag is never part of what a client is shown", () => {
  const est = estimateUsage({ messages: [{ role: "user", content: "x".repeat(100) }] }, "y");
  for (const format of ["openai", "claude", "gemini", "openai-responses"]) {
    assert.equal(filterUsageForFormat(est, format).estimated, undefined, format);
  }
});

// ── upstream usage wins, estimate only as fallback ─────────────────────────

test("an estimate is only the fallback for an upstream that reported nothing", () => {
  let called = 0;
  const estimate = () => { called++; return { prompt_tokens: 7, completion_tokens: 1, estimated: true }; };
  assert.equal(pickRecordedUsage({ real: REAL, estimate }), REAL);
  assert.equal(called, 0, "never computed when the upstream reported usage");
  assert.equal(pickRecordedUsage({ real: { prompt_tokens: 0 }, estimate }).estimated, true);
  assert.equal(pickRecordedUsage({ real: null }), null);
});

test("merging an estimate into real usage would keep the larger wrong number (why they stay apart)", () => {
  const estimated = { prompt_tokens: 8409, completion_tokens: 1, total_tokens: 8410, estimated: true };
  assert.equal(mergeUsage(estimated, REAL).prompt_tokens, 8409);
  // and the flag does not survive a merge with real figures
  assert.equal(mergeUsage(estimated, { prompt_tokens: 5 }).estimated, undefined);
  assert.equal(mergeUsage({ prompt_tokens: 5 }, estimated).estimated, undefined);
});

test("an all-zero usage is not usable", () => {
  assert.equal(hasValidUsage({ prompt_tokens: 0, completion_tokens: 0 }), false);
  assert.equal(hasValidUsage(REAL), true);
});

// ── one canonical convention: prompt includes the cache, reasoning is inside completion ──

test("Anthropic usage folds the cache into the prompt exactly once", () => {
  const raw = extractUsage({ type: "message_start", message: { usage: { input_tokens: 31, output_tokens: 1, cache_read_input_tokens: 4480 } } });
  const merged = mergeUsage(raw, extractUsage({ type: "message_delta", usage: { output_tokens: 7 } }));
  const canon = canonicalizeUsage(merged);
  assert.equal(canon.prompt_tokens, 4511);
  assert.equal(canon.cached_tokens, 4480);
  assert.equal(canon.completion_tokens, 7);
  assert.equal(canon.total_tokens, 4518);
  // idempotent: running it again must not add the cache a second time
  assert.deepEqual(canonicalizeUsage(canon), canon);
  // cache write
  const w = canonicalizeUsage({ prompt_tokens: 10, completion_tokens: 2, cache_creation_input_tokens: 90 });
  assert.equal(w.prompt_tokens, 100);
  assert.equal(w.cache_creation_input_tokens, 90);
});

test("OpenAI, DeepSeek and Responses usage keep the cached part inside the prompt", () => {
  assert.equal(canonicalizeUsage(extractUsage({ usage: REAL })).prompt_tokens, 4511);
  assert.equal(canonicalizeUsage(extractUsage({ usage: REAL })).cached_tokens, 4480);
  const ds = canonicalizeUsage(extractUsage({ usage: { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 64, prompt_cache_miss_tokens: 36 } }));
  assert.equal(ds.prompt_tokens, 100);
  assert.equal(ds.cached_tokens, 64);
  const resp = canonicalizeUsage(extractUsage({ type: "response.completed", response: { usage: { input_tokens: 200, output_tokens: 30, input_tokens_details: { cached_tokens: 150 }, output_tokens_details: { reasoning_tokens: 12 } } } }));
  assert.equal(resp.prompt_tokens, 200);
  assert.equal(resp.cached_tokens, 150);
  assert.equal(resp.reasoning_tokens, 12);
  // a raw Responses usage object (as the forced SSE-to-JSON path hands it over) keeps its cache
  const raw = canonicalizeUsage({ input_tokens: 200, output_tokens: 30, input_tokens_details: { cached_tokens: 150 } });
  assert.equal(raw.cached_tokens, 150);
});

test("Gemini thinking tokens are output: completion carries them and reasoning is the subset", () => {
  const u = canonicalizeUsage(extractUsage({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: 5, totalTokenCount: 35, cachedContentTokenCount: 4 } }));
  assert.equal(u.prompt_tokens, 10);
  assert.equal(u.cached_tokens, 4);
  assert.equal(u.completion_tokens, 25);
  assert.equal(u.reasoning_tokens, 5);
  const body = extractUsageFromResponse({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: 5 } });
  assert.equal(body.completion_tokens, 25);
  assert.equal(canonicalizeUsage(body).reasoning_tokens, 5);
});

test("a non-stream body is read for every cached-token spelling", () => {
  assert.equal(extractUsageFromResponse({ usage: { prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: 6 } }).cached_tokens, 6);
  assert.equal(extractUsageFromResponse({ usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 6 } }).cache_read_input_tokens, 6);
  assert.equal(extractUsageFromResponse({ usage: { input_tokens: 10, output_tokens: 1, input_tokens_details: { cached_tokens: 6 } } }).cached_tokens, 6);
});

test("a non-stream reply without usage is estimated, flagged, and only when something was generated", () => {
  const req = { messages: [{ role: "user", content: "x".repeat(40) }] };
  const out = usageOrEstimate(null, req, { choices: [{ message: { role: "assistant", content: "y".repeat(8) } }] });
  assert.equal(out.estimated, true);
  assert.equal(out.prompt_tokens, 10);
  assert.equal(out.completion_tokens, 2);
  assert.equal(usageOrEstimate(null, req, { choices: [{ message: { role: "assistant", content: "" } }] }), null);
  assert.equal(usageOrEstimate(REAL, req, { choices: [] }), REAL, "real usage is never replaced");
});

// ── the dollars ────────────────────────────────────────────────────────────

const PRICE = { input: 3, cached: 0.3, output: 15, reasoning: 30 };

test("cost: a Claude request with a cached prompt is charged the cached part once", () => {
  const raw = mergeUsage(
    extractUsage({ type: "message_start", message: { usage: { input_tokens: 31, output_tokens: 1, cache_read_input_tokens: 4480 } } }),
    extractUsage({ type: "message_delta", usage: { output_tokens: 7 } }),
  );
  // 31 fresh at $3/M + 4480 cached at $0.30/M + 7 out at $15/M, in nano-USD (1 USD/M = 1000 nano per token)
  const expected = 31 * 3000 + 4480 * 300 + 7 * 15000;
  assert.equal(expected, 1_542_000);
  assert.equal(costFromTokensNano(canonicalizeUsage(raw), PRICE), expected);
  // what the double count used to bill: the cache folded twice
  const doubled = costFromTokensNano({ prompt_tokens: 8991, completion_tokens: 7, cached_tokens: 4480 }, PRICE);
  assert.ok(doubled > expected, `the old figure ${doubled} over-billed`);
  assert.equal(doubled - expected, 4480 * 3000);
});

test("cost: reasoning tokens are part of the completion and are not charged twice", () => {
  const u = canonicalizeUsage({ prompt_tokens: 0, completion_tokens: 1000, reasoning_tokens: 400 });
  // 600 plain output at $15/M + 400 reasoning at $30/M
  assert.equal(costFromTokensNano(u, PRICE), 600 * 15000 + 400 * 30000);
  // no reasoning rate: the reasoning part falls back to the output rate, total = all completion at output
  assert.equal(costFromTokensNano(u, { input: 0, output: 15 }), 1000 * 15000);
  // never more reasoning than completion
  assert.equal(canonicalizeUsage({ completion_tokens: 10, reasoning_tokens: 99 }).reasoning_tokens, 10);
});

test("cost: an estimate is priced like real usage and keeps its flag into the row", () => {
  const est = estimateUsage({ messages: [{ role: "user", content: "x".repeat(4000) }] }, "y".repeat(400));
  const canon = canonicalizeUsage(est);
  assert.equal(canon.estimated, true);
  assert.equal(canon.prompt_tokens, 1000);
  assert.equal(canon.completion_tokens, 100);
  assert.equal(costFromTokensNano(canon, PRICE), 1000 * 3000 + 100 * 15000);
});

// ── Claude-shaped usage from OpenAI usage ──────────────────────────────────

test("a Claude client is told which part of the prompt came from the cache", () => {
  assert.deepEqual(claudeUsageFromOpenAI(REAL), { input_tokens: 31, output_tokens: 2, cache_read_input_tokens: 4480 });
  assert.deepEqual(
    claudeUsageFromOpenAI({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 40, cache_creation_tokens: 10 } }),
    { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 40, cache_creation_input_tokens: 10 },
  );
  assert.deepEqual(claudeUsageFromOpenAI({ prompt_tokens: 100, completion_tokens: 5 }), { input_tokens: 100, output_tokens: 5 });
  assert.deepEqual(claudeUsageFromOpenAI({ input_tokens: 9, output_tokens: 3 }), { input_tokens: 9, output_tokens: 3 });
  assert.equal(claudeUsageFromOpenAI({ prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 50 } }).input_tokens, 0);
});

// ── asking the upstream for usage ──────────────────────────────────────────

const { DefaultExecutor } = await import("../open-sse/executors/default.js");

test("a streamed request to an OpenAI-compatible upstream always asks for usage", () => {
  const ex = new DefaultExecutor("openai-compatible-chat-abc");
  const body = { model: "m", stream: true, messages: [{ role: "user", content: "hi" }] };
  const out = ex.transformRequest("m", body, true, { providerSpecificData: { apiType: "chat" } });
  assert.deepEqual(out.stream_options, { include_usage: true });
  assert.equal(body.stream_options, undefined, "the caller's body is not mutated");
  assert.deepEqual(Object.keys(out), ["model", "stream", "messages", "stream_options"], "added last: the prefix of the body is unchanged");
});

test("include_usage:false from the client is overridden for billing, other options are kept", () => {
  const ex = new DefaultExecutor("openai-compatible-chat-abc");
  const withOpts = { model: "m", stream: true, messages: [], stream_options: { include_usage: false, other: 1 } };
  assert.deepEqual(ex.transformRequest("m", withOpts, true, null).stream_options, { include_usage: true, other: 1 });
  assert.equal(withOpts.stream_options.include_usage, false, "the caller's object is untouched");
  const partial = { model: "m", stream: true, messages: [], stream_options: { other: 1 } };
  assert.deepEqual(ex.transformRequest("m", partial, true, null).stream_options, { other: 1, include_usage: true });
  assert.equal(ex.transformRequest("m", { model: "m", messages: [] }, false, null).stream_options, undefined, "non-stream is left alone");
  assert.equal(ex.transformRequest("m", { model: "m", messages: [] }, true, null).stream_options, undefined, "a body that does not itself stream is left alone: OpenAI rejects stream_options there");
  const responses = new DefaultExecutor("openai-compatible-responses-abc");
  assert.equal(responses.transformRequest("m", { model: "m", stream: true, input: "x" }, true, null).stream_options, undefined);
});
