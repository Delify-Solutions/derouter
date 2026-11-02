// OpenAI SSE -> Gemini SSE for the /v1beta route: real usage, no lost lines, bounded hold.
import test from "node:test";
import assert from "node:assert/strict";
import { transformOpenAISSEToGeminiSSE, geminiUsageFromOpenAI } from "../src/lib/usage/geminiOpenAIStream.js";

const enc = new TextEncoder();
const sse = (o) => `data: ${typeof o === "string" ? o : JSON.stringify(o)}\n\n`;
const chunk = (delta, finish = null, extra = {}) => ({ id: "x", model: "m", choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
const USAGE = { prompt_tokens: 4511, completion_tokens: 20, total_tokens: 4531, prompt_tokens_details: { cached_tokens: 4480 }, completion_tokens_details: { reasoning_tokens: 8 } };

function run(parts, opts) {
  const body = new ReadableStream({ start(c) { for (const p of parts) c.enqueue(enc.encode(p)); c.close(); } });
  return new Response(transformOpenAISSEToGeminiSSE({ ok: true, body }, "m", opts).body).text();
}
const chunks = (text) => text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)));

test("usage metadata keeps thinking out of the candidates and reports the cache", () => {
  assert.deepEqual(geminiUsageFromOpenAI(USAGE), { promptTokenCount: 4511, candidatesTokenCount: 12, totalTokenCount: 4531, thoughtsTokenCount: 8, cachedContentTokenCount: 4480 });
});

test("the usage chunk that follows the finish chunk completes the single terminal chunk", async () => {
  const out = chunks(await run([sse(chunk({ content: "Hi" })), sse(chunk({}, "stop")), sse({ id: "x", choices: [], usage: USAGE }), sse(chunk({}, "stop")), "data: [DONE]\n\n"]));
  const finals = out.filter((c) => c.candidates[0].finishReason);
  assert.equal(finals.length, 1);
  assert.equal(finals[0].usageMetadata.promptTokenCount, 4511);
});

test("a final data line without a trailing newline is not dropped", async () => {
  const out = chunks(await run([sse(chunk({ content: "Hi" })), `data: ${JSON.stringify(chunk({}, "stop", { usage: USAGE }))}`]));
  assert.equal(out.length, 2);
  assert.equal(out[1].candidates[0].finishReason, "STOP");
  assert.equal(out[1].usageMetadata.cachedContentTokenCount, 4480);
});

test("a line split across network chunks is reassembled", async () => {
  const line = sse(chunk({ content: "Hello" }));
  const out = chunks(await run([line.slice(0, 20), line.slice(20)]));
  assert.equal(out[0].candidates[0].content.parts[0].text, "Hello");
});

test("a silent upstream does not hold the terminal chunk: it is released after the hold delay", async () => {
  let ctrl;
  const body = new ReadableStream({ start(c) { ctrl = c; } });
  const res = new Response(transformOpenAISSEToGeminiSSE({ ok: true, body }, "m", { holdMs: 20 }).body);
  const reader = res.body.getReader();
  ctrl.enqueue(enc.encode(sse(chunk({ content: "Hi" })) + sse(chunk({}, "stop"))));
  let text = "";
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && !text.includes("finishReason")) {
    const { value, done } = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r({ timeout: true }), 100))]);
    if (done) break;
    if (value) text += new TextDecoder().decode(value);
  }
  assert.match(text, /finishReason/, "released while the socket is still open");
  ctrl.close();
  await reader.cancel().catch(() => {});
});
