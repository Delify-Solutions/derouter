// Command Code's per-model thinking efforts: read from its public catalog in the background,
// with a snapshot as the fallback, and looked up synchronously by the thinking code.
import test from "node:test";
import assert from "node:assert/strict";

const efforts = await import("../open-sse/services/commandcodeEfforts.js");
const { getThinkingLevels } = await import("../open-sse/providers/thinkingLevels.js");

const CATALOG = {
  refreshAfterSeconds: 900,
  data: [
    { id: "deepseek/deepseek-v4.1-flash", aliases: ["deepseek-v4.1-flash-legacy"], reasoningEfforts: ["off", "low", "high", "max"] },
    { id: "zai-org/GLM-5.3", aliases: [], reasoningEfforts: ["low", "high", "max"] },
    { id: "moonshotai/Kimi-K2.6", aliases: [], reasoningEfforts: null },
    { id: "brand/new-model", aliases: [], reasoningEfforts: ["low", "medium"] },
  ],
};
const okFetch = (body, calls) => async () => { calls.n += 1; return { ok: true, json: async () => body }; };

test.beforeEach(() => efforts.resetCommandCodeCatalogForTests());

test("parse: off becomes none, a null list becomes 'no effort', aliases map to the model", () => {
  const map = efforts.parseCommandCodeEfforts(CATALOG);
  assert.deepEqual(map["deepseek/deepseek-v4.1-flash"], ["none", "low", "high", "max"]);
  assert.deepEqual(map["deepseek-v4.1-flash-legacy"], ["none", "low", "high", "max"]);
  assert.deepEqual(map["moonshotai/Kimi-K2.6"], []);
  assert.equal(Object.keys(efforts.parseCommandCodeEfforts(null)).length, 0);
});

test("before any live read the snapshot answers, including models with no effort list", () => {
  assert.deepEqual(efforts.getCommandCodeEfforts("deepseek/deepseek-v4.1-flash"), ["none", "low", "high", "max"]);
  assert.deepEqual(efforts.getCommandCodeEfforts("moonshotai/Kimi-K2.6"), []);
  assert.equal(efforts.getCommandCodeEfforts("brand/new-model"), undefined);
  // case-insensitive fallback
  assert.deepEqual(efforts.getCommandCodeEfforts("ZAI-ORG/glm-5.3"), ["low", "high", "max"]);
  // a model with no effort setting exposes no thinking levels
  assert.equal(getThinkingLevels("commandcode", "moonshotai/Kimi-K2.6"), null);
});

test("the live catalog wins once read, and a new model is picked up", async () => {
  const calls = { n: 0 };
  assert.equal(await efforts.refreshCommandCodeEffortsIfStale({ fetchImpl: okFetch(CATALOG, calls), now: 1_000 }), true);
  assert.deepEqual(efforts.getCommandCodeEfforts("brand/new-model"), ["low", "medium"]);
  assert.deepEqual(getThinkingLevels("commandcode", "brand/new-model"), ["low", "medium"]);
  // fresh: 60 s later is inside refreshAfterSeconds (900 s), so no request is made
  assert.equal(await efforts.refreshCommandCodeEffortsIfStale({ fetchImpl: okFetch(CATALOG, calls), now: 61_000 }), false);
  assert.equal(calls.n, 1);
  // stale: 901 s after the read
  assert.equal(await efforts.refreshCommandCodeEffortsIfStale({ fetchImpl: okFetch(CATALOG, calls), now: 902_000 }), true);
  assert.equal(calls.n, 2);
});

test("a model the live catalog does not list falls back to the snapshot; a listed one is overridden", async () => {
  const live = { refreshAfterSeconds: 900, data: [{ id: "zai-org/GLM-5.3", aliases: [], reasoningEfforts: ["high"] }] };
  await efforts.refreshCommandCodeEffortsIfStale({ fetchImpl: okFetch(live, { n: 0 }), now: 1 });
  assert.deepEqual(efforts.getCommandCodeEfforts("zai-org/GLM-5.3"), ["high"], "live overrides the snapshot");
  assert.deepEqual(efforts.getCommandCodeEfforts("deepseek/deepseek-v4.1-flash"), ["none", "low", "high", "max"], "dropped from live: snapshot");
});

test("the server's refresh interval is honoured within bounds", async () => {
  const calls = { n: 0 };
  // 1 s from the server is raised to the 60 s minimum
  await efforts.refreshCommandCodeEffortsIfStale({ fetchImpl: okFetch({ ...CATALOG, refreshAfterSeconds: 1 }, calls), now: 0 });
  assert.equal(await efforts.refreshCommandCodeEffortsIfStale({ fetchImpl: okFetch(CATALOG, calls), now: 30_000 }), false);
  assert.equal(calls.n, 1);
  assert.equal(await efforts.refreshCommandCodeEffortsIfStale({ fetchImpl: okFetch(CATALOG, calls), now: 61_000 }), true);
  assert.equal(calls.n, 2);
});

test("a fetch that throws synchronously does not leave the refresh stuck", async () => {
  const syncThrow = () => { throw new Error("boom"); };
  assert.equal(await efforts.refreshCommandCodeEffortsIfStale({ fetchImpl: syncThrow, now: 0 }), false);
  // after the retry window a working fetch is used again
  const calls = { n: 0 };
  assert.equal(await efforts.refreshCommandCodeEffortsIfStale({ fetchImpl: okFetch(CATALOG, calls), now: 61_000 }), true);
  assert.equal(calls.n, 1);
});

test("catalog ids are plain keys and unknown effort strings are dropped", () => {
  const map = efforts.parseCommandCodeEfforts({ data: [
    { id: "__proto__", reasoningEfforts: ["low"] },
    { id: "odd/model", reasoningEfforts: ["low", "turbo", "off"] },
  ] });
  assert.deepEqual(map["__proto__"], ["low"]);
  assert.deepEqual(map["odd/model"], ["low", "none"]);
  // lookups never return inherited properties
  assert.equal(efforts.getCommandCodeEfforts("constructor"), undefined);
  assert.equal(efforts.getCommandCodeEfforts("Constructor"), undefined);
});

test("concurrent refreshes share one request", async () => {
  const calls = { n: 0 };
  const f = okFetch(CATALOG, calls);
  await Promise.all([efforts.refreshCommandCodeEffortsIfStale({ fetchImpl: f }), efforts.refreshCommandCodeEffortsIfStale({ fetchImpl: f })]);
  assert.equal(calls.n, 1);
});

test("a failed read keeps the snapshot, never throws, and backs off", async () => {
  let n = 0;
  const failing = async () => { n += 1; throw new Error("network down"); };
  assert.equal(await efforts.refreshCommandCodeEffortsIfStale({ fetchImpl: failing }), false);
  assert.deepEqual(efforts.getCommandCodeEfforts("deepseek/deepseek-v4.1-flash"), ["none", "low", "high", "max"]);
  // within the retry window nothing is fetched again
  assert.equal(await efforts.refreshCommandCodeEffortsIfStale({ fetchImpl: failing }), false);
  assert.equal(n, 1);
  // a non-2xx or an empty catalog is a failure too
  efforts.resetCommandCodeCatalogForTests();
  assert.equal(await efforts.refreshCommandCodeEffortsIfStale({ fetchImpl: async () => ({ ok: false, status: 503 }) }), false);
  efforts.resetCommandCodeCatalogForTests();
  assert.equal(await efforts.refreshCommandCodeEffortsIfStale({ fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }) }), false);
});
