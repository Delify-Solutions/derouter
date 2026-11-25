// Stream auto-continue: a mid-stream upstream drop splices a fresh attempt into
// the SAME client-visible stream (open-sse/utils/stream.js markContinuationStarted
// / getContinuationSnapshot, driven by pipeWithDisconnect). Client never sees two
// messages, and the operator is billed for BOTH attempts' real upstream cost.
import test from "node:test";
import assert from "node:assert/strict";
import { drive, driveSegments, capture, data, DONE, payloads, countDone, streamMod, FORMATS } from "./helpers/stream-run.mjs";
import { canonicalizeUsage } from "../open-sse/utils/usageTracking.js";

const { createPassthroughStreamWithLogger, createSSETransformStreamWithLogger } = streamMod;
const sumUsagesMod = await import("../open-sse/utils/usageTracking.js");

const REQ = { model: "m", messages: [{ role: "user", content: "hi" }] };

const chunk = (delta, finish = null, extra = {}) => ({
  id: "chatcmpl-attempt-1", object: "chat.completion.chunk", created: 1700000000, model: "m",
  choices: [{ index: 0, delta, finish_reason: finish }], ...extra,
});
const chunk2 = (delta, finish = null, extra = {}) => ({
  id: "chatcmpl-attempt-2-DIFFERENT", object: "chat.completion.chunk", created: 1700000100, model: "m",
  choices: [{ index: 0, delta, finish_reason: finish }], ...extra,
});
const usageOnly = (id, usage) => ({ id, object: "chat.completion.chunk", created: 1700000000, model: "m", choices: [], usage });

function passthrough(opts = {}, cap = capture()) {
  return { cap, ts: createPassthroughStreamWithLogger("openai-compatible-chat-x", null, "m", "c1", REQ, cap.onStreamComplete, "k", opts) };
}

// ── sumUsages: the correctness-critical piece (billing across separate calls) ──

test("sumUsages adds tokens across attempts; mergeUsage's Math.max would drop one", () => {
  const { sumUsages, mergeUsage } = sumUsagesMod;
  const a1 = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };
  const a2 = { prompt_tokens: 160, completion_tokens: 30, total_tokens: 190 };
  assert.deepEqual(sumUsages([a1, a2]), { prompt_tokens: 260, completion_tokens: 80, total_tokens: 340 });
  // sanity: mergeUsage (correct for ONE continuous stream) is NOT what we want here
  assert.deepEqual(mergeUsage(a1, a2), { prompt_tokens: 160, completion_tokens: 50, total_tokens: 190 });
});

test("sumUsages: a single entry passes through unchanged; empty/falsy entries are ignored", () => {
  const { sumUsages } = sumUsagesMod;
  const only = { prompt_tokens: 5, completion_tokens: 1 };
  assert.equal(sumUsages([only]), only);
  assert.equal(sumUsages([]), null);
  assert.deepEqual(sumUsages([null, { prompt_tokens: 2, completion_tokens: 1 }, undefined]), { prompt_tokens: 2, completion_tokens: 1 });
});

test("sumUsages: estimated survives only if every attempt was estimated", () => {
  const { sumUsages } = sumUsagesMod;
  const real = { prompt_tokens: 10, completion_tokens: 5 };
  const estimated = { prompt_tokens: 3, completion_tokens: 1, estimated: true };
  assert.equal(sumUsages([real, estimated]).estimated, undefined);
  assert.equal(sumUsages([estimated, estimated]).estimated, true);
});

// ── stream.js splice: id/role normalization, usage summed, tool-call bail ──────

test("a continuation's repeated role and fresh id never reach the client; usage sums across both attempts", async () => {
  const { cap, ts } = passthrough({ clientFormat: FORMATS.OPENAI });
  const segment1 = [data(chunk({ role: "assistant", content: "Hello " }))]; // dropped before any usage/finish
  const segment2 = [
    data(chunk2({ role: "assistant", content: "world" })), // upstream naturally resends role on the new call
    data(chunk2({}, "stop")),
    data(usageOnly("chatcmpl-attempt-2-DIFFERENT", { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 })),
    data(chunk2({}, "stop")),
    DONE,
  ];
  const out = await driveSegments(ts, [segment1, segment2]);

  assert.equal(payloads(out).filter((p) => p.choices?.[0]?.delta?.role).length, 1, "role appears exactly once across the whole spliced stream");
  assert.equal(new Set(payloads(out).map((p) => p.id)).size, 1, "every chunk keeps attempt #1's id");
  assert.equal(payloads(out)[0].id, "chatcmpl-attempt-1");
  assert.equal(countDone(out), 1);
  assert.equal(out.includes("Hello "), true);
  assert.equal(out.includes("world"), true);

  assert.equal(cap.calls, 1);
  const canon = canonicalizeUsage(cap.usage);
  // Attempt #2 reported 20/3; attempt #1 reported none but generated "Hello "
  // (6 chars -> floored/estimated, never zero) — summed, never just attempt #2's.
  assert.ok(canon.prompt_tokens >= 20, "attempt #2's real prompt tokens are included");
  assert.ok(canon.completion_tokens > 3, "attempt #1's generated text is estimated in on top of attempt #2's real count");
});

// Drains `ts.readable` in the background (discarding output) while the caller
// writes and inspects snapshot state mid-stream — writing without a reader can
// stall on backpressure once flush()/finalize start enqueuing more output.
function drainInBackground(ts) {
  const reader = ts.readable.getReader();
  return (async () => { for (;;) { const { done } = await reader.read(); if (done) return; } })();
}

test("a tool call in flight makes the stream ineligible for auto-continue", async () => {
  const { ts } = passthrough({ clientFormat: FORMATS.OPENAI });
  const drained = drainInBackground(ts);
  const writer = ts.writable.getWriter();
  await writer.write(new TextEncoder().encode(data(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "{\"pa" } }] }))));
  assert.equal(ts.getContinuationSnapshot().eligible, false, "a started tool call must never be auto-continued as plain text");
  await writer.close();
  await drained;
});

test("getContinuationSnapshot is only eligible for passthrough (same format in and out)", async () => {
  const cap = capture();
  const ts = createSSETransformStreamWithLogger(FORMATS.CLAUDE, FORMATS.OPENAI, "anthropic", null, null, "m", "c1", REQ, cap.onStreamComplete, "k");
  const drained = drainInBackground(ts);
  const writer = ts.writable.getWriter();
  await writer.write(new TextEncoder().encode(data(chunk({ role: "assistant", content: "hi" }))));
  assert.equal(ts.getContinuationSnapshot().eligible, false, "format translation is out of scope for v1 auto-continue");
  await writer.close();
  await drained;
});

test("plain single-attempt streams are completely unaffected (no continuationCount, byte-for-byte)", async () => {
  const { cap, ts } = passthrough({ clientFormat: FORMATS.OPENAI });
  const input = [data(chunk({ role: "assistant", content: "hi" })), data(chunk({}, "stop")), data(usageOnly("chatcmpl-attempt-1", { prompt_tokens: 5, completion_tokens: 1 })), DONE];
  const out = await drive(ts, input);
  assert.equal(out, input.join(""), "untouched: no continuation ever started");
  assert.equal(cap.usage.prompt_tokens, 5);
});
