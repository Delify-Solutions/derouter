// A client that disconnects stops the request (change hardening-wave1): the
// upstream call is cancelled, the attempt is a 499, nothing is retried and the
// pending counter goes back down exactly once.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { register } from "node:module";

register("./helpers/alias-hook.mjs", import.meta.url);

const { handleChatCore } = await import("../open-sse/handlers/chatCore.js");
const { initTranslators } = await import("../open-sse/translator/index.js");
const usageDb = await import("./helpers/stub-usageDb.mjs");
await initTranslators();

async function slowUpstream(delayMs) {
  const seen = { hits: 0, closedEarly: 0 };
  const server = http.createServer((req, res) => {
    seen.hits++;
    let done = false;
    res.on("close", () => { if (!done) seen.closedEarly++; });
    req.resume();
    setTimeout(() => {
      if (res.destroyed) return;
      done = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", object: "chat.completion", model: "m", choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }));
    }, delayMs);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { seen, server, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

function call(baseUrl, requestSignal) {
  return handleChatCore({
    body: { model: "openai-compatible-chat-test/m", messages: [{ role: "user", content: "hello" }], stream: false },
    modelInfo: { provider: "openai-compatible-chat-test", model: "m" },
    credentials: { apiKey: "k", providerSpecificData: { baseUrl } },
    log: null,
    requestSignal,
  });
}

test("a client that leaves before the answer cancels the upstream call at once and is a 499", async () => {
  const up = await slowUpstream(2000);
  usageDb.calls.trackPendingRequest.length = 0;
  usageDb.calls.appendRequestLog.length = 0;
  const controller = new AbortController();
  // Next aborts a disconnected request's signal with its own reason, not an AbortError.
  setTimeout(() => controller.abort(new Error("ResponseAborted")), 150);
  const started = Date.now();
  try {
    const result = await call(up.baseUrl, controller.signal);
    assert.equal(result.success, false);
    assert.equal(result.status, 499);
    assert.ok(Date.now() - started < 1000, "no network retries are spent on a client that left");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(up.seen.hits, 1, "nothing is resent");
    assert.equal(up.seen.closedEarly, 1, "the upstream call was cancelled");
    assert.ok(usageDb.calls.appendRequestLog.some((e) => e.status === "FAILED 499"));
    await new Promise((r) => setTimeout(r, 600)); // the controller's delayed abort
    const pending = usageDb.calls.trackPendingRequest.map((args) => args[3]);
    assert.deepEqual(pending, [true, false], "one increment, one decrement");
  } finally {
    up.server.closeAllConnections();
    up.server.close();
  }
});

test("a client that waits gets the answer as before", async () => {
  const up = await slowUpstream(100);
  try {
    const result = await call(up.baseUrl, new AbortController().signal);
    assert.equal(result.success, true);
    assert.equal(result.response.status, 200);
    assert.equal(up.seen.closedEarly, 0);
  } finally {
    up.server.closeAllConnections();
    up.server.close();
  }
});
