import test from "node:test";
import assert from "node:assert/strict";
import { extractGeminiNativeUsage } from "../src/lib/usage/geminiNativeUsage.js";

test("a generateContent body yields prompt and output tokens", () => {
  const body = JSON.stringify({
    candidates: [{ content: { parts: [{ inlineData: { data: "AAAA" } }] } }],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 300, totalTokenCount: 312 },
  });
  assert.deepEqual(extractGeminiNativeUsage(body), { prompt_tokens: 12, completion_tokens: 300 });
});

test("output includes thinking tokens: everything beyond the prompt", () => {
  const body = JSON.stringify({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: 5, totalTokenCount: 35 } });
  assert.deepEqual(extractGeminiNativeUsage(body), { prompt_tokens: 10, completion_tokens: 25 });
});

test("in an SSE stream the last usageMetadata wins", () => {
  const sse = [
    'data: {"candidates":[{}],"usageMetadata":{"promptTokenCount":5,"totalTokenCount":5}}',
    "",
    'data: {"candidates":[{}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":90,"totalTokenCount":95}}',
    "",
  ].join("\n");
  assert.deepEqual(extractGeminiNativeUsage(sse), { prompt_tokens: 5, completion_tokens: 90 });
});

test("an error body, an empty body and a body without usage give null", () => {
  assert.equal(extractGeminiNativeUsage(JSON.stringify({ error: { message: "bad" } })), null);
  assert.equal(extractGeminiNativeUsage(""), null);
  assert.equal(extractGeminiNativeUsage("data: [DONE]\n"), null);
  assert.equal(extractGeminiNativeUsage(JSON.stringify({ usageMetadata: { promptTokenCount: 0, totalTokenCount: 0 } })), null);
});

test("garbage never throws", () => {
  assert.equal(extractGeminiNativeUsage("{not json"), null);
  assert.equal(extractGeminiNativeUsage(null), null);
});

test("cached prompt tokens are carried so they are priced at the cached rate", () => {
  const body = JSON.stringify({ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5, totalTokenCount: 105, cachedContentTokenCount: 80 } });
  assert.deepEqual(extractGeminiNativeUsage(body), { prompt_tokens: 100, completion_tokens: 5, cached_tokens: 80 });
  const bogus = JSON.stringify({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15, cachedContentTokenCount: 99 } });
  assert.deepEqual(extractGeminiNativeUsage(bogus), { prompt_tokens: 10, completion_tokens: 5 });
});
