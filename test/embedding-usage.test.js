// Embeddings usage (change hardening-wave1): never served free when the upstream
// reports no usable count.
import test from "node:test";
import assert from "node:assert/strict";

const { embeddingUsage, estimateEmbeddingInputTokens } = await import("../open-sse/utils/embeddingUsage.js");

test("the upstream's exact count wins", () => {
  assert.deepEqual(embeddingUsage({ prompt_tokens: 12, total_tokens: 12 }, "ignored"), {
    tokens: { prompt_tokens: 12, completion_tokens: 0, total_tokens: 12 }, estimated: false,
  });
  assert.equal(embeddingUsage({ prompt_tokens: 12 }, "x").estimated, false, "a missing total is not a reason to guess");
});

test("Gemini's zeros and odd counts fall back to a flagged estimate from the input", () => {
  const text = "a".repeat(400); // 100 tokens at 4 ASCII characters per token
  for (const raw of [{ prompt_tokens: 0, total_tokens: 0 }, null, { prompt_tokens: 5, total_tokens: 9 }, { prompt_tokens: 3, total_tokens: 3, estimated: true }]) {
    const u = embeddingUsage(raw, text);
    assert.equal(u.estimated, true, JSON.stringify(raw));
    assert.deepEqual(u.tokens, { prompt_tokens: 100, completion_tokens: 0, total_tokens: 100 });
  }
});

test("every OpenAI input shape is measured", () => {
  assert.equal(estimateEmbeddingInputTokens(["a".repeat(40), "b".repeat(40)]), 20);
  assert.equal(estimateEmbeddingInputTokens([101, 102, 103]), 3, "token ids count one each");
  assert.equal(estimateEmbeddingInputTokens([[1, 2], [3, 4, 5]]), 5);
  assert.equal(estimateEmbeddingInputTokens([{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }]), 1000, "an image is one flat media item");
  assert.equal(estimateEmbeddingInputTokens([{ type: "text", text: "a".repeat(40) }]), 10);
  assert.equal(estimateEmbeddingInputTokens(""), 0);
  assert.equal(embeddingUsage({ prompt_tokens: 0 }, ""), null, "nothing to bill for an empty input");
});
