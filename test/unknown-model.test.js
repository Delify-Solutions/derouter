// A model name that is no combo, alias or configured provider/model is reported as
// "model not found", not as missing credentials for a provider the caller never
// named (spec upstream-error-handling "Unknown model").
import { test } from "node:test";
import assert from "node:assert/strict";

const { getModelInfoCore } = await import("../open-sse/services/model.js");
const { modelNotFoundMessage } = await import("../src/lib/auth/platformError.js");

test("a bare unknown name is resolved to a guessed provider and flagged as a guess", async () => {
  const info = await getModelInfoCore("no-such-model-xyz", {});
  assert.equal(info.provider, "openai");
  assert.equal(info.inferred, true);
});

test("an alias or an explicit provider/model is not a guess", async () => {
  const aliased = await getModelInfoCore("fast", { fast: "openai/gpt-4o-mini" });
  assert.deepEqual(aliased, { provider: "openai", model: "gpt-4o-mini" });
  const explicit = await getModelInfoCore("anthropic/claude-x", {});
  assert.equal(explicit.inferred, undefined);
});

test("the message names the model the caller asked for, not a provider", () => {
  const message = modelNotFoundMessage("no-such-model-xyz");
  assert.match(message, /no-such-model-xyz/);
  assert.match(message, /không tồn tại/);
  assert.match(message, /\/v1\/models/);
  assert.doesNotMatch(message, /openai|credential/i);
});
