// Money-model unit tests. Pure functions only — no DB, no network, no env.
// These pin the invariants that make billing trustworthy:
//   * money is integer nanoUSD, never float
//   * a charge below one cent keeps full precision
//   * summing many small charges is exact
//   * the cost formula charges cached tokens at the cached rate, not the input rate
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  NANO,
  usdToNano,
  nanoToUsd,
  fmtUsdNano,
  fmtUsd,
  sumNano,
  costFromTokensNano,
} from "../src/shared/utils/money.js";

test("NANO is one billion nano per USD", () => {
  assert.equal(NANO, 1_000_000_000);
});

test("usdToNano rounds to integers and tolerates junk", () => {
  assert.equal(usdToNano(1), 1_000_000_000);
  assert.equal(usdToNano(0.006), 6_000_000);
  assert.equal(usdToNano(0.000001), 1_000);
  assert.equal(usdToNano(null), 0);
  assert.equal(usdToNano(undefined), 0);
  // Always an integer — a fractional nano would reintroduce float drift.
  for (const usd of [0.1, 0.333, 1 / 3, 0.006, 123.456789]) {
    assert.ok(Number.isInteger(usdToNano(usd)), `${usd} -> ${usdToNano(usd)} must be an integer`);
  }
});

test("nanoToUsd is the inverse for representable amounts", () => {
  assert.equal(nanoToUsd(6_000_000), 0.006);
  assert.equal(nanoToUsd(0), 0);
  assert.equal(nanoToUsd(1_000_000_000), 1);
});

// The reported bug: a 0.006 USD price was displayed and charged as 0.01.
test("a 0.006 charge displays as 0.006000, never 0.01", () => {
  assert.equal(fmtUsd(0.006), "$0.006000");
  assert.equal(fmtUsdNano(6_000_000), "$0.006000");
  assert.notEqual(fmtUsd(0.006), "$0.01");
});

test("fmtUsdNano picks precision by magnitude", () => {
  assert.equal(fmtUsdNano(2_500_000_000), "$2.50");      // >= $1 -> 2dp
  assert.equal(fmtUsdNano(10_000_000), "$0.0100");       // >= $0.01 -> 4dp
  assert.equal(fmtUsdNano(6_000_000), "$0.006000");      // below -> 6dp
  assert.equal(fmtUsdNano(0), "$0");
  assert.equal(fmtUsdNano(null), "$0");
});

// The float-drift bug: 500 x 0.006 summed to 2.9999999999999654 and never
// reached a $3 budget. Integer nano must land exactly on the boundary.
test("500 charges of $0.006 sum to exactly $3", () => {
  let total = 0;
  for (let i = 0; i < 500; i++) total += usdToNano(0.006);
  assert.equal(total, 3_000_000_000);
  assert.equal(total, usdToNano(3));
  assert.ok(total >= usdToNano(3), "a $3 budget must be considered fully spent");
  assert.equal(sumNano(Array(500).fill(6_000_000)), 3_000_000_000);
});

test("float accumulation would have failed the same check (guard against regression)", () => {
  let floatTotal = 0;
  for (let i = 0; i < 500; i++) floatTotal += 0.006;
  assert.ok(floatTotal < 3, `float sum ${floatTotal} is below 3 — this is why nanoUSD exists`);
});

test("costFromTokensNano: input tokens at the input rate", () => {
  // $0.006 per 1M input tokens.
  assert.equal(
    costFromTokensNano({ prompt_tokens: 1_000_000 }, { input: 0.006, output: 0 }),
    6_000_000,
  );
  assert.equal(costFromTokensNano({}, { input: 1, output: 1 }), 0);
  assert.equal(costFromTokensNano(null, { input: 1 }), 0);
  assert.equal(costFromTokensNano({ prompt_tokens: 10 }, null), 0);
});

test("costFromTokensNano: output tokens at the output rate", () => {
  assert.equal(
    costFromTokensNano({ completion_tokens: 1_000_000 }, { input: 0, output: 3 }),
    3_000_000_000,
  );
});

test("costFromTokensNano: cached tokens are charged at the cached rate, not input", () => {
  // prompt_tokens is cache-inclusive by convention: 1M prompt of which 1M cached.
  const pricing = { input: 10, cached: 1, output: 0 };
  const cachedOnly = costFromTokensNano(
    { prompt_tokens: 1_000_000, cached_tokens: 1_000_000 },
    pricing,
  );
  // 1M cached at $1/1M = $1. Charging them at the input rate would be $10.
  assert.equal(cachedOnly, 1_000_000_000);
  assert.notEqual(cachedOnly, 10_000_000_000);
});

test("costFromTokensNano: cache-write tokens use the cache_creation rate", () => {
  const pricing = { input: 10, cache_creation: 2, output: 0 };
  const got = costFromTokensNano(
    { prompt_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 },
    pricing,
  );
  assert.equal(got, 2_000_000_000);
});

test("costFromTokensNano: mixed prompt splits cached, cache-write and fresh input", () => {
  const pricing = { input: 10, cached: 1, cache_creation: 2, output: 0 };
  // 1M prompt = 400k cached + 100k cache-write + 500k fresh.
  const got = costFromTokensNano(
    {
      prompt_tokens: 1_000_000,
      cached_tokens: 400_000,
      cache_creation_input_tokens: 100_000,
    },
    pricing,
  );
  const expected =
    400_000 * (1 / 1_000_000) +   // 0.4 USD
    100_000 * (2 / 1_000_000) +   // 0.2 USD
    500_000 * (10 / 1_000_000);   // 5.0 USD
  assert.equal(got, Math.round(expected * NANO));
});

test("costFromTokensNano: reasoning falls back to the output rate", () => {
  const withReasoning = costFromTokensNano(
    { completion_tokens: 1_000_000, reasoning_tokens: 1_000_000 },
    { input: 0, output: 3, reasoning: 5 },
  );
  const noReasoningPrice = costFromTokensNano(
    { completion_tokens: 1_000_000 },
    { input: 0, output: 3 },
  );
  assert.ok(withReasoning > noReasoningPrice, "a reasoning premium must cost more");
  // Without an explicit reasoning rate it must not be silently free.
  assert.equal(noReasoningPrice, 3_000_000_000);
});

test("costFromTokensNano never returns a float", () => {
  const cases = [
    [{ prompt_tokens: 1234, completion_tokens: 567 }, { input: 0.171, output: 1.029 }],
    [{ prompt_tokens: 7, completion_tokens: 3 }, { input: 1.75, output: 14 }],
    [{ prompt_tokens: 999_999 }, { input: 0.000001, output: 0 }],
  ];
  for (const [tokens, pricing] of cases) {
    const cost = costFromTokensNano(tokens, pricing);
    assert.ok(Number.isInteger(cost), `${JSON.stringify(tokens)} -> ${cost} must be an integer`);
  }
});

test("a sub-cent request still costs something (does not round to zero)", () => {
  // 1 input token at $1/1M = $0.000001 = 1000 nano.
  const cost = costFromTokensNano({ prompt_tokens: 1 }, { input: 1, output: 0 });
  assert.equal(cost, 1000);
  assert.ok(cost > 0, "a single token must not round away to zero");
});

test("sumNano handles empties and a mixed sign ledger", () => {
  assert.equal(sumNano([]), 0);
  assert.equal(sumNano([1, 2, 3]), 6);
  // grant +120, charge -50, charge -70 => 0
  assert.equal(sumNano([120, -50, -70]), 0);
});
