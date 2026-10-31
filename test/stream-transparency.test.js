// Stream behaviour (specs proxy-transparency and usage-accuracy): same-format streams reach the
// client byte for byte, usage is observed on the side, and recorded usage is the upstream's.
import test from "node:test";
import assert from "node:assert/strict";
import { drive, capture, data, event, DONE, payloads, countDone, streamMod, FORMATS } from "./helpers/stream-run.mjs";
import { canonicalizeUsage, hasValidUsage } from "../open-sse/utils/usageTracking.js";
import { costFromTokensNano } from "../src/shared/utils/money.js";

const { createPassthroughStreamWithLogger, createSSETransformStreamWithLogger } = streamMod;

const REQ = { model: "m", messages: [{ role: "user", content: "x".repeat(33_000) }] };
const PRICE = { input: 3, cached: 0.3, output: 15 };

const chunk = (delta, finish = null, extra = {}) => ({
  id: "chatcmpl-abcdef123456", object: "chat.completion.chunk", created: 1700000000, model: "m",
  choices: [{ index: 0, delta, finish_reason: finish }], ...extra,
});
const usageOnly = (usage) => ({ id: "chatcmpl-abcdef123456", object: "chat.completion.chunk", created: 1700000000, model: "m", choices: [], usage });
const REAL = { prompt_tokens: 4511, completion_tokens: 2, total_tokens: 4513, prompt_tokens_details: { cached_tokens: 4480 } };

function passthrough(opts = {}, cap = capture()) {
  return { cap, ts: createPassthroughStreamWithLogger("openai-compatible-chat-x", null, "m", "c1", REQ, cap.onStreamComplete, "k", opts) };
}

// the boltz shape: finish, usage-only chunk (cached tokens), finish again, [DONE]
const BOLTZ = [
  data(chunk({ role: "assistant", content: "" })),
  data(chunk({ content: "Hi" })),
  data(chunk({}, "stop")),
  data(usageOnly(REAL)),
  data(chunk({}, "stop")),
  DONE,
];

// ── OpenAI chat, same format ───────────────────────────────────────────────

test("boltz shape, client asked for usage: one finish, then the usage chunk, then one [DONE]", async () => {
  const { cap, ts } = passthrough({ clientFormat: FORMATS.OPENAI });
  const out = await drive(ts, BOLTZ);
  const expected = BOLTZ.slice(0, 4).join("") + DONE;
  assert.equal(out, expected, "the repeated finish chunk is the only thing withheld");
  assert.equal(payloads(out).filter((p) => p.choices?.[0]?.finish_reason).length, 1);
  assert.equal(countDone(out), 1);
  // recorded: the real figures, nothing added
  assert.equal(cap.calls, 1);
  const canon = canonicalizeUsage(cap.usage);
  assert.equal(canon.prompt_tokens, 4511);
  assert.equal(canon.cached_tokens, 4480);
  assert.equal(canon.completion_tokens, 2);
  assert.equal(canon.estimated, undefined);
  assert.equal(costFromTokensNano(canon, PRICE), 31 * 3000 + 4480 * 300 + 2 * 15000);
});

test("boltz shape, client did not ask for usage: the usage-only chunk the router requested is withheld", async () => {
  const { cap, ts } = passthrough({ clientFormat: FORMATS.OPENAI, suppressUsageChunk: true });
  const out = await drive(ts, BOLTZ);
  assert.equal(out, BOLTZ.slice(0, 3).join("") + DONE, "exactly what the upstream sends a client that did not ask for usage");
  assert.equal(JSON.parse(JSON.stringify(payloads(out))).some((p) => p.usage), false);
  assert.equal(canonicalizeUsage(cap.usage).prompt_tokens, 4511, "but it is still observed and recorded");
});

test("n > 1: the finish chunk of each choice is forwarded, only a true repeat is withheld", async () => {
  const two = (index, finish, extra = {}) => ({ id: "chatcmpl-abcdef123456", object: "chat.completion.chunk", created: 1700000000, model: "m", choices: [{ index, delta: finish ? {} : { content: "a" }, finish_reason: finish }], ...extra });
  const input = [data(two(0, null)), data(two(1, null)), data(two(0, "stop")), data(two(1, "stop")), data(two(1, "stop")), data(usageOnly(REAL)), DONE];
  const { ts } = passthrough({ clientFormat: FORMATS.OPENAI });
  const out = await drive(ts, input);
  assert.equal(out, [input[0], input[1], input[2], input[3], input[5], DONE].join(""));
});

test("usage inside the finish chunk: every byte is forwarded unchanged", async () => {
  const input = [
    data(chunk({ role: "assistant", content: "" })),
    data(chunk({ content: "Hi" })),
    data(chunk({}, "stop", { usage: REAL })),
    DONE,
  ];
  const { cap, ts } = passthrough({ clientFormat: FORMATS.OPENAI });
  assert.equal(await drive(ts, input), input.join(""));
  assert.equal(canonicalizeUsage(cap.usage).cached_tokens, 4480);
});

test("an upstream that reports no usage: nothing is injected, the estimate is recorded flagged, with no margin", async () => {
  const input = [data(chunk({ role: "assistant", content: "" })), data(chunk({ content: "abcdefgh" })), data(chunk({}, "stop")), DONE];
  const { cap, ts } = passthrough({ clientFormat: FORMATS.OPENAI });
  const out = await drive(ts, input);
  assert.equal(out, input.join(""), "bytes identical: no usage fabricated for the client");
  assert.equal(cap.usage.estimated, true);
  assert.equal(cap.usage.prompt_tokens, Math.ceil(33_000 / 4), "request text / 4, no +2000");
  assert.equal(cap.usage.completion_tokens, 2);
  assert.equal(cap.usage.total_tokens, cap.usage.prompt_tokens + 2);
});

test("a reply that is only a tool call still counts as output for the estimate", async () => {
  const tc = { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Hanoi"}' } }] };
  const input = [data(chunk(tc)), data(chunk({}, "tool_calls")), DONE];
  const { cap, ts } = passthrough({ clientFormat: FORMATS.OPENAI });
  await drive(ts, input);
  assert.ok(cap.usage?.estimated);
  assert.ok(cap.usage.completion_tokens > 0);
});

test("strict mode never repairs, strips or drops anything", async () => {
  const input = [
    'data:{"id":"chat","choices":[{"index":0,"delta":{"content":"a","tool_calls":[]},"finish_reason":null,"content_filter_results":{"x":1}}],"prompt_filter_results":[{"a":1}]}\n\n',
    ": keep-alive comment\n\n",
    "data: plain text, not json\n\n",
    data(chunk({ content: "" })),
    data(chunk({}, "stop", { usage: REAL })),
    DONE,
  ];
  const { ts } = passthrough({ clientFormat: FORMATS.OPENAI });
  assert.equal(await drive(ts, input), input.join(""));
});

test("two [DONE] lines from an upstream reach the client as one", async () => {
  const input = [data(chunk({ content: "a" })), data(chunk({}, "stop", { usage: REAL })), DONE, DONE];
  const { ts } = passthrough({ clientFormat: FORMATS.OPENAI });
  const out = await drive(ts, input);
  assert.equal(countDone(out), 1);
  assert.equal(out, input.slice(0, 3).join(""));
});

test("strict mode does not invent a [DONE] the upstream never sent", async () => {
  const input = [data(chunk({ content: "a" })), data(chunk({}, "stop", { usage: REAL }))];
  const { ts } = passthrough({ clientFormat: FORMATS.OPENAI });
  assert.equal(await drive(ts, input), input.join(""));
});

test("chunk boundaries inside a line do not change the bytes", async () => {
  const whole = BOLTZ.slice(0, 3).join("") + DONE;
  const bytes = new TextEncoder().encode(whole);
  const pieces = [];
  for (let i = 0; i < bytes.length; i += 7) pieces.push(bytes.slice(i, i + 7));
  const { ts } = passthrough({ clientFormat: FORMATS.OPENAI });
  assert.equal(await drive(ts, pieces), whole);
});

test("multi-byte characters split across upstream chunks come out intact", async () => {
  const line = data(chunk({ content: "Xin chào, Việt Nam ế" }));
  const bytes = new TextEncoder().encode(line);
  const cut = bytes.indexOf(0xe1) + 1; // inside a 3-byte sequence
  const { ts } = passthrough({ clientFormat: FORMATS.OPENAI });
  const out = await drive(ts, [bytes.slice(0, cut), bytes.slice(cut), new TextEncoder().encode(DONE)]);
  assert.equal(out, line + DONE);
});

test("compat mode restores the legacy repairs (and the sentinel) but never adds tokens", async () => {
  const input = [
    'data:{"id":"chat","choices":[{"index":0,"delta":{"content":"a","tool_calls":[]},"content_filter_results":{"x":1}}]}\n\n',
    data(chunk({ content: "" })),
    data(chunk({}, "stop", { usage: REAL })),
  ];
  const { cap, ts } = passthrough({ clientFormat: FORMATS.OPENAI, compat: true });
  const out = await drive(ts, input);
  const first = payloads(out)[0];
  assert.match(first.id, /^chatcmpl-/, "id repaired");
  assert.equal(first.object, "chat.completion.chunk");
  assert.ok(first.created > 0);
  assert.equal(first.choices[0].delta.tool_calls, undefined);
  assert.equal(first.choices[0].content_filter_results, undefined);
  assert.equal(payloads(out).length, 2, "the empty-content chunk is dropped");
  assert.equal(countDone(out), 1, "sentinel added");
  const last = payloads(out).at(-1);
  assert.equal(last.usage.prompt_tokens, 4511, "usage forwarded exactly, no +2000");
  assert.equal(canonicalizeUsage(cap.usage).prompt_tokens, 4511);
});

test("a provider that answers a streamed request with one JSON document: bytes forwarded, usage still recorded", async () => {
  const doc = JSON.stringify({ id: "chatcmpl-1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }], usage: REAL }, null, 2);
  const { cap, ts } = passthrough({ clientFormat: FORMATS.OPENAI });
  const out = await drive(ts, [doc.slice(0, 40), doc.slice(40)]);
  assert.equal(out, doc, "no SSE framing, no [DONE], same bytes");
  assert.equal(canonicalizeUsage(cap.usage).prompt_tokens, 4511);
  assert.equal(canonicalizeUsage(cap.usage).cached_tokens, 4480);
  // and without usage in the document the output is estimated and flagged
  const none = capture();
  const ts2 = createPassthroughStreamWithLogger("openai-compatible-chat-x", null, "m", "c1", REQ, none.onStreamComplete, "k", { clientFormat: FORMATS.OPENAI });
  await drive(ts2, [JSON.stringify({ choices: [{ message: { role: "assistant", content: "abcdefgh" } }] })]);
  assert.equal(none.usage.estimated, true);
  assert.equal(none.usage.completion_tokens, 2);
});

// ── Anthropic, same format ─────────────────────────────────────────────────

const CLAUDE_STREAM = [
  event("message_start", { type: "message_start", message: { id: "msg_01", type: "message", role: "assistant", model: "m", content: [], usage: { input_tokens: 31, output_tokens: 1, cache_read_input_tokens: 4480, cache_creation_input_tokens: 0 } } }),
  event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } }),
  event("content_block_stop", { type: "content_block_stop", index: 0 }),
  event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } }),
  event("message_stop", { type: "message_stop" }),
];

test("Anthropic stream: bytes identical, no [DONE] appended, cache counted once", async () => {
  const cap = capture();
  const ts = createPassthroughStreamWithLogger("anthropic-compatible-x", null, "m", "c1", REQ, cap.onStreamComplete, "k", { clientFormat: FORMATS.CLAUDE });
  const out = await drive(ts, CLAUDE_STREAM);
  assert.equal(out, CLAUDE_STREAM.join(""));
  assert.equal(countDone(out), 0);
  const canon = canonicalizeUsage(cap.usage);
  assert.equal(canon.prompt_tokens, 4511, "input 31 + cache_read 4480, not folded twice");
  assert.equal(canon.cached_tokens, 4480);
  assert.equal(canon.completion_tokens, 7);
  assert.equal(costFromTokensNano(canon, PRICE), 31 * 3000 + 4480 * 300 + 7 * 15000);
  assert.equal(canon.estimated, undefined);
});

// ── Responses, same format ─────────────────────────────────────────────────

test("Responses stream: bytes identical, no [DONE] appended, cached tokens from input_tokens_details", async () => {
  const input = [
    event("response.created", { type: "response.created", response: { id: "resp_1", status: "in_progress", usage: null } }),
    event("response.output_text.delta", { type: "response.output_text.delta", delta: "Hi" }),
    event("response.completed", { type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 200, output_tokens: 30, total_tokens: 230, input_tokens_details: { cached_tokens: 150 }, output_tokens_details: { reasoning_tokens: 12 } } } }),
  ];
  const cap = capture();
  const ts = createPassthroughStreamWithLogger("openai-compatible-responses-x", null, "m", "c1", REQ, cap.onStreamComplete, "k", { clientFormat: FORMATS.OPENAI_RESPONSES });
  const out = await drive(ts, input);
  assert.equal(out, input.join(""), "even the `usage: null` field of response.created survives");
  const canon = canonicalizeUsage(cap.usage);
  assert.equal(canon.prompt_tokens, 200);
  assert.equal(canon.cached_tokens, 150);
  assert.equal(canon.reasoning_tokens, 12);
  assert.equal(cap.calls, 1, "finalized once");
});

// ── translation: Claude upstream -> OpenAI client ──────────────────────────

test("Claude upstream to an OpenAI client: the cached prompt is recorded once and shown once", async () => {
  const cap = capture();
  const ts = createSSETransformStreamWithLogger(FORMATS.CLAUDE, FORMATS.OPENAI, "anthropic-compatible-x", null, null, "m", "c1", REQ, cap.onStreamComplete, "k");
  const out = await drive(ts, CLAUDE_STREAM);
  const finish = payloads(out).find((p) => p.choices?.[0]?.finish_reason);
  assert.equal(finish.usage.prompt_tokens, 4511);
  assert.equal(finish.usage.prompt_tokens_details.cached_tokens, 4480);
  assert.equal(finish.usage.completion_tokens, 7);
  assert.equal(finish.usage.total_tokens, 4518);
  const canon = canonicalizeUsage(cap.usage);
  assert.equal(canon.prompt_tokens, 4511, "was 8991: the translator's cache-inclusive prompt was folded again");
  assert.equal(canon.cached_tokens, 4480);
  assert.equal(costFromTokensNano(canon, PRICE), 31 * 3000 + 4480 * 300 + 7 * 15000);
});

// ── translation: OpenAI chat upstream -> Claude / Responses client ─────────

test("boltz shape to a Claude client: message_delta carries the real usage, one terminal event", async () => {
  const cap = capture();
  const ts = createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.CLAUDE, "openai-compatible-chat-x", null, null, "m", "c1", REQ, cap.onStreamComplete, "k");
  const out = await drive(ts, BOLTZ);
  const events = payloads(out);
  const deltas = events.filter((e) => e.type === "message_delta");
  assert.equal(deltas.length, 1);
  assert.deepEqual(deltas[0].usage, { input_tokens: 31, output_tokens: 2, cache_read_input_tokens: 4480 });
  assert.equal(events.filter((e) => e.type === "message_stop").length, 1);
  assert.equal(events.at(-1).type, "message_stop");
  assert.equal(countDone(out), 0);
  assert.equal(canonicalizeUsage(cap.usage).prompt_tokens, 4511);
  assert.equal(canonicalizeUsage(cap.usage).estimated, undefined);
});

test("usage already on the finish chunk to a Claude client needs no waiting", async () => {
  const input = [data(chunk({ role: "assistant", content: "" })), data(chunk({ content: "Hi" })), data(chunk({}, "stop", { usage: REAL })), DONE];
  const ts = createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.CLAUDE, "openai-compatible-chat-x", null, null, "m", "c1", REQ, capture().onStreamComplete, "k");
  const out = await drive(ts, input);
  assert.deepEqual(payloads(out).find((e) => e.type === "message_delta").usage, { input_tokens: 31, output_tokens: 2, cache_read_input_tokens: 4480 });
});

test("no usage from the upstream to a Claude client: a zeroed placeholder, not an estimate; the estimate is only recorded", async () => {
  const input = [data(chunk({ role: "assistant", content: "" })), data(chunk({ content: "abcdefgh" })), data(chunk({}, "stop")), DONE];
  const cap = capture();
  const ts = createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.CLAUDE, "openai-compatible-chat-x", null, null, "m", "c1", REQ, cap.onStreamComplete, "k");
  const out = await drive(ts, input);
  const delta = payloads(out).find((e) => e.type === "message_delta");
  assert.deepEqual(delta.usage, { input_tokens: 0, output_tokens: 0 });
  assert.equal(payloads(out).filter((e) => e.type === "message_stop").length, 1);
  assert.equal(cap.usage.estimated, true);
  assert.equal(cap.usage.prompt_tokens, Math.ceil(33_000 / 4));
});

test("a usage-only chunk that comes BEFORE the finish chunk still reaches the Claude client", async () => {
  const input = [data(chunk({ role: "assistant", content: "" })), data(chunk({ content: "Hi" })), data(usageOnly(REAL)), data(chunk({}, "stop")), DONE];
  const ts = createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.CLAUDE, "openai-compatible-chat-x", null, null, "m", "c1", REQ, capture().onStreamComplete, "k");
  const out = await drive(ts, input);
  assert.deepEqual(payloads(out).find((e) => e.type === "message_delta").usage, { input_tokens: 31, output_tokens: 2, cache_read_input_tokens: 4480 });
});

test("a stream that ends right after the finish chunk still delivers the held terminal event", async () => {
  const input = [data(chunk({ role: "assistant", content: "" })), data(chunk({ content: "Hi" })), data(chunk({}, "stop"))];
  const ts = createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.CLAUDE, "openai-compatible-chat-x", null, null, "m", "c1", REQ, capture().onStreamComplete, "k");
  const out = await drive(ts, input);
  assert.equal(payloads(out).filter((e) => e.type === "message_stop").length, 1);
});

test("a held terminal event is released after the hold delay when the upstream stays silent", async () => {
  const cap = capture();
  const ts = createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.CLAUDE, "openai-compatible-chat-x", null, null, "m", "c1", REQ, cap.onStreamComplete, "k", null, { finishHoldMs: 30 });
  const writer = ts.writable.getWriter();
  const reader = ts.readable.getReader();
  let out = "";
  const pump = (async () => { for (;;) { const { done, value } = await reader.read(); if (done) break; out += new TextDecoder().decode(value); } })();
  const enc = new TextEncoder();
  for (const c of [data(chunk({ role: "assistant", content: "" })), data(chunk({ content: "abcdefgh" })), data(chunk({}, "stop"))]) await writer.write(enc.encode(c));
  await new Promise((r) => setTimeout(r, 150));
  // no usage, no [DONE], socket still open: the client already has its terminal event
  assert.equal(payloads(out).filter((e) => e.type === "message_stop").length, 1);
  assert.deepEqual(payloads(out).find((e) => e.type === "message_delta").usage, { input_tokens: 0, output_tokens: 0 });
  // the usage that arrives afterwards is still recorded, and nothing is emitted twice
  await writer.write(enc.encode(data(usageOnly(REAL)) + data(chunk({}, "stop")) + DONE));
  await writer.close();
  await pump;
  assert.equal(payloads(out).filter((e) => e.type === "message_stop").length, 1);
  assert.equal(payloads(out).filter((e) => e.type === "message_delta").length, 1);
  assert.equal(canonicalizeUsage(cap.usage).prompt_tokens, 4511);
  assert.equal(cap.calls, 1);
});

test("a stream that stays silent after a released finish is recorded as an estimate when it is cut", async () => {
  const cap = capture();
  const ts = createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.CLAUDE, "openai-compatible-chat-x", null, null, "m", "c1", REQ, cap.onStreamComplete, "k", null, { finishHoldMs: 20 });
  const writer = ts.writable.getWriter();
  const reader = ts.readable.getReader();
  const pump = (async () => { for (;;) { const { done } = await reader.read(); if (done) break; } })();
  const enc = new TextEncoder();
  for (const c of [data(chunk({ content: "abcdefgh" })), data(chunk({}, "stop"))]) await writer.write(enc.encode(c));
  await new Promise((r) => setTimeout(r, 80));
  ts.abortFinalize();
  assert.equal(cap.usage.estimated, true);
  assert.equal(cap.calls, 1);
  await writer.close();
  await pump;
  assert.equal(cap.calls, 1, "the normal end after the cut does not record again");
});

test("boltz shape to a Responses client: response.completed carries the real usage", async () => {
  const cap = capture();
  const ts = createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "openai-compatible-chat-x", null, null, "m", "c1", REQ, cap.onStreamComplete, "k");
  const out = await drive(ts, BOLTZ);
  const completed = payloads(out).filter((e) => e.type === "response.completed");
  assert.equal(completed.length, 1);
  assert.deepEqual(completed[0].response.usage, { input_tokens: 4511, output_tokens: 2, total_tokens: 4513, input_tokens_details: { cached_tokens: 4480 } });
  assert.equal(canonicalizeUsage(cap.usage).prompt_tokens, 4511);
});

test("no usage from the upstream to a Responses client: the field is simply absent", async () => {
  const input = [data(chunk({ role: "assistant", content: "" })), data(chunk({ content: "abcdefgh" })), data(chunk({}, "stop")), DONE];
  const cap = capture();
  const ts = createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "openai-compatible-chat-x", null, null, "m", "c1", REQ, cap.onStreamComplete, "k");
  const out = await drive(ts, input);
  const completed = payloads(out).find((e) => e.type === "response.completed");
  assert.equal(completed.response.usage, undefined);
  assert.equal(cap.usage.estimated, true);
});

// ── failed / aborted streams ───────────────────────────────────────────────

async function partial(ts, chunks) {
  const writer = ts.writable.getWriter();
  const reader = ts.readable.getReader();
  const pump = (async () => { for (;;) { const { done } = await reader.read(); if (done) break; } })();
  for (const c of chunks) await writer.write(new TextEncoder().encode(c));
  return { writer, pump };
}

test("an aborted stream records the usage the upstream had already reported", async () => {
  const cap = capture();
  const ts = createSSETransformStreamWithLogger(FORMATS.CLAUDE, FORMATS.OPENAI, "anthropic-compatible-x", null, null, "m", "c1", REQ, cap.onStreamComplete, "k");
  await partial(ts, CLAUDE_STREAM.slice(0, 3));
  ts.abortFinalize();
  assert.equal(cap.calls, 1);
  assert.equal(canonicalizeUsage(cap.usage).prompt_tokens, 4511, "message_start's input and cache are known and real");
  assert.equal(cap.usage.estimated, undefined);
  ts.abortFinalize();
  assert.equal(cap.calls, 1, "idempotent");
});

test("an aborted stream with no usage but delivered output records a flagged estimate", async () => {
  const cap = capture();
  const { ts } = passthrough({ clientFormat: FORMATS.OPENAI }, cap);
  await partial(ts, [data(chunk({ role: "assistant", content: "" })), data(chunk({ content: "abcdefgh" }))]);
  ts.abortFinalize();
  assert.equal(cap.usage.estimated, true);
  assert.equal(cap.usage.completion_tokens, 2);
});

test("an aborted stream that produced nothing records nothing invented", async () => {
  const cap = capture();
  const { ts } = passthrough({ clientFormat: FORMATS.OPENAI }, cap);
  await partial(ts, [data(chunk({ role: "assistant", content: "" }))]);
  ts.abortFinalize();
  assert.equal(hasValidUsage(cap.usage), false);
});
