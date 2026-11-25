// pipeWithDisconnect's retry orchestration (open-sse/utils/streamHandler.js): the
// plumbing that splices a continuation's upstream bytes into the SAME transform
// instance after a mid-stream drop, or falls back to today's clean-stream-end
// behavior when it can't/shouldn't retry.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/alias-hook.mjs", import.meta.url);

const { createStreamController, pipeWithDisconnect, isContinuableDrop } = await import("../open-sse/utils/streamHandler.js");
const { createPassthroughStreamWithLogger } = await import("../open-sse/utils/stream.js");

const enc = new TextEncoder();
const dec = new TextDecoder();
const chunk = (content, finish = null, id = "chatcmpl-1") =>
  `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finish }] })}\n\n`;

function terminated() {
  return Object.assign(new TypeError("terminated"), { cause: {} });
}

/**
 * A Response-like object whose body yields `parts` one per pull, then either
 * closes or errors with `fail`. One part per pull (not all enqueued in
 * `start()`) matters: enqueuing a chunk and erroring in the same synchronous
 * tick discards the queued chunk entirely (a controller.error() clears it per
 * spec) — pull-based delivery lets the reader actually consume each part
 * before the stream moves to its terminal state, the same way a real socket
 * delivers some bytes before it resets.
 */
function fakeResponse(parts, fail = null) {
  let i = 0;
  return {
    ok: true,
    body: new ReadableStream({
      pull(controller) {
        if (i < parts.length) { controller.enqueue(enc.encode(parts[i])); i++; return; }
        if (fail) controller.error(fail);
        else controller.close();
      },
    }),
  };
}

async function readAll(readable) {
  const reader = readable.getReader();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

function noopLogController() {
  return createStreamController({ provider: "p", model: "m" });
}

test("a continuable drop with a working retry: both attempts reach the client on one stream, no error", async () => {
  const first = fakeResponse([chunk("Hello ")], terminated());
  const second = fakeResponse([chunk("world"), chunk(null, "stop"), "data: [DONE]\n\n"]);
  let markedStarted = 0;
  let retryCalls = 0;
  const transformStream = createPassthroughStreamWithLogger("openai-compatible-chat-x", null, "m", "c1", { model: "m" }, () => {}, "k", { clientFormat: "openai" });
  const realMark = transformStream.markContinuationStarted;
  transformStream.markContinuationStarted = () => { markedStarted++; realMark(); };

  const streamController = noopLogController();
  const continuation = {
    enabled: true,
    maxAttempts: 2,
    getSnapshot: () => transformStream.getContinuationSnapshot(),
    retry: async () => { retryCalls++; return { response: second }; },
  };

  const out = await readAll(pipeWithDisconnect(first, transformStream, streamController, null, 5000, continuation));
  assert.equal(retryCalls, 1);
  assert.equal(markedStarted, 1);
  assert.ok(out.includes("Hello "));
  assert.ok(out.includes("world"));
  assert.equal((out.match(/data: \[DONE\]/g) || []).length, 1);
});

test("a continuable drop whose retry also fails falls back to a clean stream end (no CRITICAL error)", async () => {
  const first = fakeResponse([chunk("Hello ")], terminated());
  let retryCalls = 0;
  const transformStream = createPassthroughStreamWithLogger("openai-compatible-chat-x", null, "m", "c1", { model: "m" }, () => {}, "k", { clientFormat: "openai" });
  const streamController = noopLogController();
  const continuation = {
    enabled: true,
    maxAttempts: 2,
    getSnapshot: () => transformStream.getContinuationSnapshot(),
    retry: async () => { retryCalls++; return null; }, // the retry itself could not even get a response
  };

  const readable = pipeWithDisconnect(first, transformStream, streamController, null, 5000, continuation);
  // Must not throw/reject: a failed retry degrades to today's graceful close.
  const out = await readAll(readable);
  assert.equal(retryCalls, 1);
  assert.ok(out.includes("Hello "));
});

test("ineligible (tool call started) never calls retry even though continuation is enabled", async () => {
  const toolChunk = `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "read", arguments: "{" } }] }, finish_reason: null }] })}\n\n`;
  const first = fakeResponse([toolChunk], terminated());
  let retryCalls = 0;
  const transformStream = createPassthroughStreamWithLogger("openai-compatible-chat-x", null, "m", "c1", { model: "m" }, () => {}, "k", { clientFormat: "openai" });
  const streamController = noopLogController();
  const continuation = {
    enabled: true,
    maxAttempts: 2,
    getSnapshot: () => transformStream.getContinuationSnapshot(),
    retry: async () => { retryCalls++; return { response: fakeResponse(["data: [DONE]\n\n"]) }; },
  };
  await readAll(pipeWithDisconnect(first, transformStream, streamController, null, 5000, continuation));
  assert.equal(retryCalls, 0, "a tool call already in flight must never be auto-continued as plain text");
});

test("continuation disabled (null): behaves exactly like before — no retry attempt at all", async () => {
  const first = fakeResponse([chunk("Hello ")], terminated());
  const transformStream = createPassthroughStreamWithLogger("openai-compatible-chat-x", null, "m", "c1", { model: "m" }, () => {}, "k", { clientFormat: "openai" });
  const streamController = noopLogController();
  const out = await readAll(pipeWithDisconnect(first, transformStream, streamController, null, 5000, null));
  assert.ok(out.includes("Hello "));
});

test("isContinuableDrop: terminated/ECONNRESET/socket-hang-up are retryable; AbortError/plain-ETIMEDOUT are not", () => {
  assert.equal(isContinuableDrop(new TypeError("terminated")), true);
  assert.equal(isContinuableDrop(Object.assign(new Error("socket hang up"))), true);
  assert.equal(isContinuableDrop(Object.assign(new Error("x"), { code: "ECONNRESET" })), true);
  assert.equal(isContinuableDrop(Object.assign(new Error("aborted"), { name: "AbortError" })), false);
  assert.equal(isContinuableDrop(Object.assign(new Error("x"), { code: "ETIMEDOUT" })), false, "our own stall abort, not a transport drop");
});

test("maxAttempts bounds the retry loop: a second drop past the budget gives up", async () => {
  const first = fakeResponse([chunk("a")], terminated());
  let retryCalls = 0;
  const transformStream = createPassthroughStreamWithLogger("openai-compatible-chat-x", null, "m", "c1", { model: "m" }, () => {}, "k", { clientFormat: "openai" });
  const streamController = noopLogController();
  const continuation = {
    enabled: true,
    maxAttempts: 1,
    getSnapshot: () => transformStream.getContinuationSnapshot(),
    retry: async () => {
      retryCalls++;
      return { response: fakeResponse([chunk("b")], terminated()) }; // this one also drops
    },
  };
  const out = await readAll(pipeWithDisconnect(first, transformStream, streamController, null, 5000, continuation));
  assert.equal(retryCalls, 1, "exactly one retry spent, then the budget is exhausted");
  assert.ok(out.includes("a"));
  assert.ok(out.includes("b"));
});
