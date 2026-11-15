// A completion turned into a Claude message keeps the cached part in Claude's own usage
// fields (spec usage-accuracy "Clients see the cached part in their own format").
import { test } from "node:test";
import assert from "node:assert/strict";
import { openAICompletionToClaudeMessage } from "../open-sse/translator/concerns/claudeMessage.js";

const completion = (usage) => ({
  id: "chatcmpl-1",
  model: "m",
  choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  usage,
});

test("cached prompt tokens leave input_tokens and appear as cache_read_input_tokens", () => {
  const out = openAICompletionToClaudeMessage(completion({
    prompt_tokens: 4511, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4480 },
  }));
  assert.deepEqual(out.usage, { input_tokens: 31, output_tokens: 2, cache_read_input_tokens: 4480 });
});

test("no cache details: plain input and output", () => {
  const out = openAICompletionToClaudeMessage(completion({ prompt_tokens: 10, completion_tokens: 3 }));
  assert.deepEqual(out.usage, { input_tokens: 10, output_tokens: 3 });
});

test("no usage at all gives zeros, not a crash", () => {
  const out = openAICompletionToClaudeMessage(completion(undefined));
  assert.deepEqual(out.usage, { input_tokens: 0, output_tokens: 0 });
});
