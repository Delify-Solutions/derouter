// Cache-miss detection (change cache-miss-auto-refund, capability cache-miss-refund).
//
// Pure unit tests against evaluateCacheMissCandidate: no server, no proxied request —
// just the prefix-overlap rule, the zero-cache-read rule, the pricing eligibility rule
// and the refund math. Each test uses its own apiKeyId so the module's shared,
// in-memory per-scope estimator never leaks state between cases.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-cache-miss-test-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const { updatePricing, resetAllPricing } = await import("../src/lib/db/repos/pricingRepo.js");
const { evaluateCacheMissCandidate, CACHE_MISS_PREFIX_THRESHOLD } = await import(
  "../src/lib/billing/cacheMissDetection.js"
);
const { NANO } = await import("../src/shared/utils/money.js");

let keyCounter = 0;
function freshKeyId() {
  keyCounter += 1;
  return `test-key-${keyCounter}`;
}

const PROVIDER = "test-provider";
const MODEL = "test-model";

before(async () => {
  await getAdapter();
});

// 1000-character prompt: long enough that character-level overlap tracks token-level
// overlap closely regardless of the cache block rounding inherited from cacheEstimator.
function promptOfLength(n, seed = "x") {
  return seed.repeat(Math.max(1, Math.ceil(n / seed.length))).slice(0, n);
}

async function seedPricing({ input = 3, cached = 0.3, output = 15 } = {}) {
  await resetAllPricing();
  await updatePricing({ [PROVIDER]: { [MODEL]: { input, cached, output } } });
}

test("flagged — continuing conversation, zero cache-read", async () => {
  await seedPricing();
  const apiKeyId = freshKeyId();
  // A tiny tail (20 of 4020 chars, ~99.5% shared prefix) keeps the overlap comfortably
  // above 90% even after cacheEstimator's own conservative 64-token block rounding.
  const first = promptOfLength(4000);
  const second = first + promptOfLength(20, "y");

  // First request: nothing to compare against yet, never flagged, but remembers
  // its own text for the second request's comparison.
  const firstResult = await evaluateCacheMissCandidate({
    apiKeyId, provider: PROVIDER, model: MODEL,
    promptText: first, promptTokens: 1024, cacheReadTokens: 0, costNanoUsd: NANO,
  });
  assert.equal(firstResult, null);

  const secondResult = await evaluateCacheMissCandidate({
    apiKeyId, provider: PROVIDER, model: MODEL,
    promptText: second, promptTokens: 1024, cacheReadTokens: 0, costNanoUsd: NANO,
  });
  assert.ok(secondResult, "expected the continuing request to be flagged");
  assert.ok(secondResult.overlapTokens > 0);
  assert.ok(secondResult.refundNanoUsd > 0);
});

test("not flagged — context changed (below the prefix threshold)", async () => {
  await seedPricing();
  const apiKeyId = freshKeyId();
  await evaluateCacheMissCandidate({
    apiKeyId, provider: PROVIDER, model: MODEL,
    promptText: promptOfLength(2000, "a"), promptTokens: 500, cacheReadTokens: 0, costNanoUsd: NANO,
  });

  // Only the first ~20% of characters match — a new conversation / branched history.
  const unrelated = promptOfLength(400, "a") + promptOfLength(1600, "b");
  const result = await evaluateCacheMissCandidate({
    apiKeyId, provider: PROVIDER, model: MODEL,
    promptText: unrelated, promptTokens: 500, cacheReadTokens: 0, costNanoUsd: NANO,
  });
  assert.equal(result, null);
});

test("not flagged — partial cache (non-zero cache-read tokens)", async () => {
  await seedPricing();
  const apiKeyId = freshKeyId();
  const first = promptOfLength(4000);
  await evaluateCacheMissCandidate({
    apiKeyId, provider: PROVIDER, model: MODEL,
    promptText: first, promptTokens: 1024, cacheReadTokens: 0, costNanoUsd: NANO,
  });

  const second = first + promptOfLength(20, "y");
  const result = await evaluateCacheMissCandidate({
    apiKeyId, provider: PROVIDER, model: MODEL,
    promptText: second, promptTokens: 1024, cacheReadTokens: 128, costNanoUsd: NANO,
  });
  assert.equal(result, null);
});

test("not flagged — model/provider pair cannot cache (zero cached rate)", async () => {
  await resetAllPricing();
  await updatePricing({ [PROVIDER]: { [MODEL]: { input: 3, cached: 0, output: 15 } } });
  const apiKeyId = freshKeyId();
  const first = promptOfLength(4000);
  await evaluateCacheMissCandidate({
    apiKeyId, provider: PROVIDER, model: MODEL,
    promptText: first, promptTokens: 1024, cacheReadTokens: 0, costNanoUsd: NANO,
  });

  // Overlap alone would clear the 90% threshold — only the zero cached-rate
  // eligibility rule is what must block this one.
  const second = first + promptOfLength(20, "y");
  const result = await evaluateCacheMissCandidate({
    apiKeyId, provider: PROVIDER, model: MODEL,
    promptText: second, promptTokens: 1024, cacheReadTokens: 0, costNanoUsd: NANO,
  });
  assert.equal(result, null);
});

test("not flagged — no preceding request at all", async () => {
  await seedPricing();
  const apiKeyId = freshKeyId();
  const result = await evaluateCacheMissCandidate({
    apiKeyId, provider: PROVIDER, model: MODEL,
    promptText: promptOfLength(2000), promptTokens: 500, cacheReadTokens: 0, costNanoUsd: NANO,
  });
  assert.equal(result, null);
});

test("refund amount: (input rate - cached rate) * overlap tokens", async () => {
  // $3/1M input, $0.30/1M cached -> $2.70/1M nanoUSD-per-token difference.
  await seedPricing({ input: 3, cached: 0.3, output: 15 });
  const apiKeyId = freshKeyId();
  const first = promptOfLength(4000);
  await evaluateCacheMissCandidate({
    apiKeyId, provider: PROVIDER, model: MODEL,
    promptText: first, promptTokens: 1000, cacheReadTokens: 0, costNanoUsd: 100 * NANO,
  });

  // Identical prompt (100% overlap) isolates the formula from the threshold logic.
  const result = await evaluateCacheMissCandidate({
    apiKeyId, provider: PROVIDER, model: MODEL,
    promptText: first, promptTokens: 1000, cacheReadTokens: 0, costNanoUsd: 100 * NANO,
  });
  assert.ok(result);
  const rate = Number((3 - 0.3).toFixed(10)); // $2.70 per 1M tokens
  const expected = Math.round((rate * NANO) / 1_000_000 * result.overlapTokens);
  assert.equal(result.refundNanoUsd, expected);
});

test("refund never exceeds the request's actual cost", async () => {
  await seedPricing({ input: 3, cached: 0.3, output: 15 });
  const apiKeyId = freshKeyId();
  const first = promptOfLength(4000);
  await evaluateCacheMissCandidate({
    apiKeyId, provider: PROVIDER, model: MODEL,
    promptText: first, promptTokens: 1000, cacheReadTokens: 0, costNanoUsd: 1, // essentially free
  });

  const result = await evaluateCacheMissCandidate({
    apiKeyId, provider: PROVIDER, model: MODEL,
    promptText: first, promptTokens: 1000, cacheReadTokens: 0, costNanoUsd: 1,
  });
  assert.ok(result);
  assert.equal(result.refundNanoUsd, 1);
});

test("CACHE_MISS_PREFIX_THRESHOLD is 90%", () => {
  assert.equal(CACHE_MISS_PREFIX_THRESHOLD, 0.9);
});
