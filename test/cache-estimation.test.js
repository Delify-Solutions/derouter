// Estimated cached tokens (spec usage-accuracy, "Estimated cache"): the estimator, the
// "only when estimated" rule, the price, and the combo option's persistence.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-cacheest-test-"));
process.env.DATA_DIR = tmpDir;
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const {
  createCacheEstimator, commonPrefixLength, promptTextForCache, applyEstimatedCache, cacheScope, TEXTS_PER_SCOPE,
  positiveNumber, shrinkBinaryPayloads, makeCacheCtx,
} = await import("../open-sse/utils/cacheEstimator.js");
const { estimateUsage, canonicalizeUsage } = await import("../open-sse/utils/usageTracking.js");
const { costFromTokensNano } = await import("../src/shared/utils/money.js");
const { comboHasCacheEstimation, isValidCacheEstimationInput, withCacheEstimation } = await import("../src/lib/combos/cacheEstimation.js");

const SCOPE = "k1|conn|m";
const lorem = (n) => ("lorem ipsum dolor sit amet ".repeat(Math.ceil(n / 27))).slice(0, n);

// ── estimator ──────────────────────────────────────────────────────────────

test("no stored prompt, or nothing in common: 0", () => {
  const e = createCacheEstimator();
  assert.equal(e.estimateCachedTokens(SCOPE, lorem(4000), 1000), 0);
  e.remember(SCOPE, "Z" + lorem(4000));
  assert.equal(e.estimateCachedTokens(SCOPE, lorem(4000), 1000), 0);
  assert.equal(e.estimateCachedTokens(SCOPE, "", 1000), 0);
  assert.equal(e.estimateCachedTokens(SCOPE, lorem(100), 0), 0);
});

test("a partial match is the shared fraction of the prompt tokens, rounded DOWN to 64", () => {
  const e = createCacheEstimator();
  const shared = lorem(3000);
  e.remember(SCOPE, shared + "AAAA".repeat(250)); // 4000 chars, first 3000 shared
  const next = shared + "BBBB".repeat(250);        // 4000 chars
  // 3000/4000 of 1000 prompt tokens = 750 -> floor to a multiple of 64 = 704
  assert.equal(e.estimateCachedTokens(SCOPE, next, 1000), 704);
  assert.equal(e.estimateCachedTokens(SCOPE, next, 10_000) % 64, 0);
  assert.equal(e.estimateCachedTokens(SCOPE, next, 10_000), 7488); // 7500 -> 7488
  // under one block: 0
  assert.equal(e.estimateCachedTokens(SCOPE, next, 80), 0); // 60 tokens
});

test("an identical prompt is capped below the prompt itself", () => {
  const e = createCacheEstimator();
  const t = lorem(8000);
  e.remember(SCOPE, t);
  const cached = e.estimateCachedTokens(SCOPE, t, 2000);
  assert.equal(cached, 1984); // min(2000, 1999) -> 1984
  assert.ok(cached < 2000);
});

test("an agent turn that only appends reuses everything that was sent before", () => {
  const e = createCacheEstimator();
  const turn1 = promptTextForCache({ messages: [{ role: "system", content: lorem(8000) }, { role: "user", content: "first question" }] });
  const turn2 = promptTextForCache({ messages: [{ role: "system", content: lorem(8000) }, { role: "user", content: "first question" }, { role: "assistant", content: "an answer" }, { role: "user", content: "second question" }] });
  e.remember(SCOPE, turn1);
  const common = e.commonChars(SCOPE, turn2);
  assert.ok(common >= turn1.length - 1, `shared ${common} of ${turn1.length}`);
  const cached = e.estimateCachedTokens(SCOPE, turn2, 2100);
  assert.ok(cached >= 1900 && cached % 64 === 0, `cached ${cached}`);
});

test("a changed system part invalidates the whole prefix", () => {
  const e = createCacheEstimator();
  const a = promptTextForCache({ system: "You are A. " + lorem(5000), messages: [{ role: "user", content: lorem(3000) }] });
  const b = promptTextForCache({ system: "You are B. " + lorem(5000), messages: [{ role: "user", content: lorem(3000) }] });
  e.remember(SCOPE, a);
  assert.equal(e.estimateCachedTokens(SCOPE, b, 2000), 0);
});

test("multibyte characters count as characters, not bytes", () => {
  const e = createCacheEstimator();
  const vi = "Xin chào, đây là một câu tiếng Việt dài có dấu. ".repeat(200);
  e.remember(SCOPE, vi + "kết thúc A");
  assert.equal(commonPrefixLength(vi + "x", vi + "y"), vi.length);
  assert.equal(e.commonChars(SCOPE, vi + "kết thúc B"), vi.length + "kết thúc ".length);
  const emoji = "😀".repeat(100);
  assert.equal(commonPrefixLength(emoji + "a", emoji + "b"), emoji.length);
  assert.equal(commonPrefixLength("", "abc"), 0);
});

test("the best of the remembered texts wins; the oldest of three is replaced", () => {
  const e = createCacheEstimator();
  const base = lorem(2000);
  e.remember(SCOPE, "1" + base);
  e.remember(SCOPE, "2" + base);
  e.remember(SCOPE, "3" + base);
  assert.equal(e.estimateCachedTokens(SCOPE, "1" + base + "tail", 4000) > 0, true);
  e.remember(SCOPE, "4" + base); // replaces "1..."
  assert.equal(TEXTS_PER_SCOPE, 3);
  assert.equal(e.commonChars(SCOPE, "1" + base + "tail"), 0);
  assert.equal(e.commonChars(SCOPE, "4" + base + "tail"), 1 + base.length);
});

test("a text that extends a remembered one replaces it instead of piling up", () => {
  const e = createCacheEstimator();
  const t1 = lorem(1000);
  e.remember(SCOPE, t1);
  assert.equal(e.stats().bytes, 2000); // 1000 chars, UTF-16
  e.remember(SCOPE, t1 + lorem(1000));
  assert.equal(e.stats().bytes, 4000, "only the longer text is held");
});

test("entries expire after the TTL", () => {
  let t = 1_000_000;
  const e = createCacheEstimator({ ttlMs: 10 * 60 * 1000, now: () => t });
  const text = lorem(4000);
  e.remember(SCOPE, text);
  t += 9 * 60 * 1000;
  assert.ok(e.commonChars(SCOPE, text + "x") > 0);
  t += 2 * 60 * 1000;
  assert.equal(e.commonChars(SCOPE, text + "x"), 0, "expired");
  assert.equal(e.estimateCachedTokens(SCOPE, text + "x", 1000), 0);
});

test("least recently used scopes are evicted when the memory cap is reached", () => {
  const e = createCacheEstimator({ maxTotalBytes: 10_000, maxEntryBytes: 6000 });
  const text = (c) => c.repeat(2000); // 4000 bytes each
  e.remember("a", text("a"));
  e.remember("b", text("b"));
  assert.equal(e.stats().scopes, 2);
  e.commonChars("a", text("a")); // reading does not refresh recency: only a write does
  e.remember("c", text("c"));    // 12000 > 10000: the least recently WRITTEN scope (a) goes
  assert.ok(e.stats().bytes <= 10_000);
  assert.equal(e.commonChars("a", text("a")), 0);
  assert.ok(e.commonChars("b", text("b")) > 0);
  assert.ok(e.commonChars("c", text("c")) > 0);
  e.remember("b", text("b") + "more"); // b is now the most recent
  e.remember("d", text("d"));
  assert.ok(e.commonChars("b", text("b")) > 0);
  assert.equal(e.commonChars("c", text("c")), 0);
  for (let i = 0; i < 200; i++) e.remember("s" + i, text("x") + i);
  assert.ok(e.stats().bytes <= 10_000, "never grows past the cap");
});

test("a text larger than the per-entry cap is ignored", () => {
  const e = createCacheEstimator({ maxEntryBytes: 1000, maxTotalBytes: 10_000 });
  assert.equal(e.remember(SCOPE, "x".repeat(501)), false); // 1002 bytes
  assert.equal(e.stats().bytes, 0);
  assert.equal(e.remember(SCOPE, "x".repeat(500)), true);
});

test("scopes are isolated: one key never sees another key's prefixes", () => {
  const e = createCacheEstimator();
  const text = lorem(4000);
  e.remember(cacheScope("key-A", "conn", "m"), text);
  assert.equal(e.commonChars(cacheScope("key-B", "conn", "m"), text), 0);
  assert.equal(e.commonChars(cacheScope("key-A", "other-conn", "m"), text), 0);
  assert.equal(e.commonChars(cacheScope("key-A", "conn", "other-model"), text), 0);
  assert.ok(e.commonChars(cacheScope("key-A", "conn", "m"), text) > 0);
  assert.ok(!cacheScope("key-A", "conn", "m").includes("key-A"), "the key itself is not kept as a map key");
});

// ── only for a pure estimate ───────────────────────────────────────────────

function ctxFor(est, scope, text) { return { scope, getText: () => text }; }

test("an estimated usage gets cached_tokens and the cache_estimated flag; the prompt is remembered", () => {
  const e = createCacheEstimator();
  const prev = lorem(6000);
  e.remember(SCOPE, prev);
  const usage = estimateUsage({ messages: [{ role: "user", content: lorem(6000 + 400) }] }, "abcdefgh");
  assert.equal(usage.estimated, true);
  const out = applyEstimatedCache(usage, ctxFor(e, SCOPE, prev + lorem(400)), e);
  assert.equal(out.cache_estimated, true);
  assert.ok(out.prompt_tokens_details.cached_tokens > 0);
  assert.equal(out.prompt_tokens_details.cached_tokens % 64, 0);
  assert.ok(out.prompt_tokens_details.cached_tokens < out.prompt_tokens);
  assert.equal(usage.prompt_tokens_details, undefined, "the input object is not mutated");
  const canon = canonicalizeUsage(out);
  assert.equal(canon.cached_tokens, out.prompt_tokens_details.cached_tokens);
  assert.equal(canon.estimated, true);
  assert.equal(canon.cache_estimated, true);
  assert.ok(e.commonChars(SCOPE, prev + lorem(400)) >= prev.length, "remembered for the next request");
});

test("a cold estimated request is flagged with cached 0", () => {
  const e = createCacheEstimator();
  const usage = estimateUsage({ messages: [{ role: "user", content: lorem(4000) }] }, "abc");
  const out = applyEstimatedCache(usage, ctxFor(e, SCOPE, lorem(4000)), e);
  assert.equal(out.prompt_tokens_details.cached_tokens, 0);
  assert.equal(out.cache_estimated, true);
});

test("real upstream usage is never altered, with or without cache details", () => {
  const e = createCacheEstimator();
  const prev = lorem(6000);
  e.remember(SCOPE, prev);
  for (const real of [
    { prompt_tokens: 4511, completion_tokens: 2, total_tokens: 4513 },
    { prompt_tokens: 4511, completion_tokens: 2, total_tokens: 4513, prompt_tokens_details: { cached_tokens: 4480 } },
    { input_tokens: 31, output_tokens: 7, cache_read_input_tokens: 4480 },
  ]) {
    const out = applyEstimatedCache(real, ctxFor(e, SCOPE, prev + "more"), e);
    assert.equal(out, real, "the very same object comes back");
    assert.equal(out.cache_estimated, undefined);
  }
  // but the prompt is still remembered, so a later estimated request finds it
  assert.ok(e.commonChars(SCOPE, prev + "more") >= prev.length);
});

test("without a context (combo option off) or for no usage, nothing happens and nothing is stored", () => {
  const e = createCacheEstimator();
  const usage = estimateUsage({ messages: [{ role: "user", content: "x".repeat(1000) }] }, "abc");
  assert.equal(applyEstimatedCache(usage, null, e), usage);
  assert.equal(applyEstimatedCache(null, ctxFor(e, SCOPE, "text"), e), null);
  assert.equal(e.stats().bytes, 0);
});

test("a throwing prompt reader leaves the usage as it was", () => {
  const e = createCacheEstimator();
  const usage = estimateUsage({ messages: [{ role: "user", content: "x".repeat(1000) }] }, "abc");
  assert.equal(applyEstimatedCache(usage, { scope: SCOPE, getText: () => { throw new Error("x"); } }, e), usage);
});

// ── the dollars ────────────────────────────────────────────────────────────

test("an estimated row with an estimated cache is priced with the cached part at the cached rate", () => {
  const PRICE = { input: 3, cached: 0.3, output: 15 };
  const e = createCacheEstimator();
  const prev = lorem(8000);
  e.remember(SCOPE, prev);
  const usage = estimateUsage({ messages: [{ role: "user", content: prev + lorem(1200) }] }, "y".repeat(400));
  const out = applyEstimatedCache(usage, ctxFor(e, SCOPE, prev + lorem(1200)), e);
  const canon = canonicalizeUsage(out);
  const cached = canon.cached_tokens;
  assert.ok(cached > 0);
  const expected = (canon.prompt_tokens - cached) * 3000 + cached * 300 + canon.completion_tokens * 15000;
  assert.equal(costFromTokensNano(canon, PRICE), expected);
  const withoutCache = costFromTokensNano({ ...canon, cached_tokens: 0 }, PRICE);
  assert.equal(withoutCache - expected, cached * (3000 - 300));
});

// ── prompt text ────────────────────────────────────────────────────────────

test("the prompt text is ordered as the provider renders it and appending a turn keeps the earlier text identical", () => {
  const base = { system: "sys", tools: [{ name: "t" }], messages: [{ role: "user", content: "a" }] };
  const grown = { ...base, messages: [...base.messages, { role: "assistant", content: "b" }, { role: "user", content: "c" }] };
  const t1 = promptTextForCache(base), t2 = promptTextForCache(grown);
  assert.ok(t2.startsWith(t1));
  assert.equal(promptTextForCache({ input: [{ type: "message", role: "user", content: "x" }], instructions: "i" }).startsWith("I:i"), true);
  assert.equal(promptTextForCache(null), "");
  assert.ok(promptTextForCache({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }).includes("hi"));
});

// ── combo option persistence ───────────────────────────────────────────────

test("the combo option is boolean only, off by default and removable", () => {
  assert.equal(isValidCacheEstimationInput(undefined), true);
  assert.equal(isValidCacheEstimationInput(true), true);
  assert.equal(isValidCacheEstimationInput(false), true);
  for (const bad of ["true", 1, 0, null, {}, []]) assert.equal(isValidCacheEstimationInput(bad), false, JSON.stringify(bad));
  assert.equal(comboHasCacheEstimation({ meta: {} }), false);
  assert.equal(comboHasCacheEstimation({}), false);
  assert.equal(comboHasCacheEstimation(null), false);
  assert.equal(comboHasCacheEstimation({ meta: { cacheEstimation: "yes" } }), false);
  assert.deepEqual(withCacheEstimation({ capabilities: { a: 1 } }, true), { capabilities: { a: 1 }, cacheEstimation: true });
  assert.deepEqual(withCacheEstimation({ capabilities: { a: 1 }, cacheEstimation: true }, false), { capabilities: { a: 1 } });
  assert.deepEqual(withCacheEstimation(null, false), {});
});

test("the combo option survives create, update and reload; combos without it stay off", async () => {
  const { createCombo, updateCombo, getComboById, getComboByName } = await import("../src/lib/db/repos/combosRepo.js");
  const plain = await createCombo({ name: "plain", models: ["x/y"], meta: {} });
  const on = await createCombo({ name: "cached", models: ["x/y"], meta: withCacheEstimation({}, true) });
  assert.equal(comboHasCacheEstimation(await getComboById(plain.id)), false);
  assert.equal(comboHasCacheEstimation(await getComboByName("cached")), true);
  await updateCombo(on.id, { meta: withCacheEstimation({ ...(await getComboById(on.id)).meta, capabilities: { v: 1 } }, true) });
  const after = await getComboById(on.id);
  assert.equal(comboHasCacheEstimation(after), true);
  assert.deepEqual(after.meta.capabilities, { v: 1 });
  await updateCombo(on.id, { meta: withCacheEstimation(after.meta, false) });
  assert.equal(comboHasCacheEstimation(await getComboById(on.id)), false);
  assert.deepEqual((await getComboById(plain.id)).meta, {});
});

// ── retention, env, binary payloads, keyless ───────────────────────────────

test("a scope nobody reads again is swept out after the TTL (retention, not only read-time expiry)", () => {
  let t = 5_000_000;
  const e = createCacheEstimator({ ttlMs: 60_000, sweepIntervalMs: 10_000, now: () => t });
  e.remember("idle", lorem(5000));
  e.remember("busy", lorem(5000));
  assert.equal(e.stats().scopes, 2);
  assert.equal(e.stats().bytes, 20_000);
  t += 61_000;               // past the TTL, and past the sweep interval
  e.remember("busy", lorem(5000) + "x"); // any write triggers the lazy sweep
  assert.equal(e.stats().scopes, 1, "idle scope dropped");
  assert.equal(e.stats().bytes, 10_002);
  // a read also sweeps
  t += 61_000;
  e.estimateCachedTokens("other", lorem(100), 100);
  assert.equal(e.stats().scopes, 0);
  assert.equal(e.stats().bytes, 0);
});

test("the sweep is rate limited: a scope within the TTL is never swept", () => {
  let t = 1000;
  const e = createCacheEstimator({ ttlMs: 60_000, sweepIntervalMs: 10_000, now: () => t });
  e.remember("a", lorem(1000));
  t += 30_000;
  e.remember("b", lorem(1000));
  assert.equal(e.stats().scopes, 2);
});

test("environment values are used only when they are positive finite numbers", () => {
  assert.equal(positiveNumber("1500", 7), 1500);
  for (const bad of [undefined, "", "abc", "0", "-5", "NaN", "Infinity", "-Infinity"]) assert.equal(positiveNumber(bad, 7), 7, String(bad));
});

test("inline base64 payloads become a short stable token", () => {
  const png = "iVBORw0KGgo" + "A".repeat(50_000);
  const png2 = "iVBORw0KGgo" + "B".repeat(50_000);
  const body = (data) => ({ messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: `data:image/png;base64,${data}` } }] }] });
  const a = promptTextForCache(body(png));
  assert.ok(a.length < 500, `text is ${a.length} chars, not the whole image`);
  assert.ok(!a.includes("AAAAAAAAAAAAAAAA"));
  assert.equal(promptTextForCache(body(png)), a, "stable");
  assert.notEqual(promptTextForCache(body(png2)), a, "a different image is a different token");
  assert.match(a, /data:image\/png;base64,#[0-9a-f]{12}:\d+/);
  // Anthropic / Gemini style source.data
  const claude = promptTextForCache({ messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png } }] }] });
  assert.ok(claude.length < 500);
  // text that merely mentions base64, or short data, is untouched
  assert.equal(shrinkBinaryPayloads("use base64 encoding"), "use base64 encoding");
  assert.equal(shrinkBinaryPayloads('{"data":"abc"}'), '{"data":"abc"}');
  // memory is honest: remembering that prompt costs hundreds of bytes, not 100 KB
  const e = createCacheEstimator();
  e.remember(SCOPE, a);
  assert.ok(e.stats().bytes < 1000);
  // and the same image repeated shares the prefix up to the new text
  const next = promptTextForCache({ messages: [...body(png).messages, { role: "assistant", content: "ok" }, { role: "user", content: "next" }] });
  assert.ok(e.commonChars(SCOPE, next) >= a.length - 1);
});

test("a request without an API key, or without the combo option, has no estimation context", () => {
  const base = { connectionId: "c", model: "m", getText: () => "x" };
  assert.equal(makeCacheCtx({ ...base, enabled: true, apiKey: null }), null);
  assert.equal(makeCacheCtx({ ...base, enabled: true, apiKey: "" }), null);
  assert.equal(makeCacheCtx({ ...base, enabled: false, apiKey: "k" }), null);
  assert.equal(makeCacheCtx({ ...base, enabled: "true", apiKey: "k" }), null);
  const ctx = makeCacheCtx({ ...base, enabled: true, apiKey: "k" });
  assert.equal(ctx.scope, cacheScope("k", "c", "m"));
});

test("an estimator that throws leaves the recorded usage exactly as it was", () => {
  const usage = estimateUsage({ messages: [{ role: "user", content: "x".repeat(1000) }] }, "abc");
  const broken = { estimateCachedTokens() { throw new Error("boom"); }, remember() { throw new Error("boom"); } };
  assert.equal(applyEstimatedCache(usage, { scope: SCOPE, getText: () => "text" }, broken), usage);
});
