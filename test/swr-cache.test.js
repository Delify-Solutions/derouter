import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { swr, clearSwrCache } from "../src/lib/cache/swrCache.js";

beforeEach(() => clearSwrCache());

function clock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const tick = () => new Promise((r) => setImmediate(r));

test("fresh value is served without recomputing", async () => {
  const now = clock();
  let calls = 0;
  const compute = async () => ++calls;
  assert.equal(await swr("k", { ttlMs: 1000, now }, compute), 1);
  now.advance(999);
  assert.equal(await swr("k", { ttlMs: 1000, now }, compute), 1);
  assert.equal(calls, 1);
});

test("concurrent cold callers share one computation", async () => {
  const gate = deferred();
  let calls = 0;
  const compute = () => { calls++; return gate.promise; };
  const all = Promise.all([swr("k", { ttlMs: 1000 }, compute), swr("k", { ttlMs: 1000 }, compute), swr("k", { ttlMs: 1000 }, compute)]);
  await tick();
  gate.resolve("v");
  assert.deepEqual(await all, ["v", "v", "v"]);
  assert.equal(calls, 1);
});

test("stale value is returned at once while one refresh runs in the background", async () => {
  const now = clock();
  let calls = 0;
  const gate = deferred();
  const compute = async () => {
    calls++;
    return calls === 1 ? "old" : gate.promise;
  };
  assert.equal(await swr("k", { ttlMs: 100, staleMs: 10_000, now }, compute), "old");
  now.advance(500);
  // stale: answers immediately with the old value, even though the refresh is pending
  assert.equal(await swr("k", { ttlMs: 100, staleMs: 10_000, now }, compute), "old");
  assert.equal(await swr("k", { ttlMs: 100, staleMs: 10_000, now }, compute), "old");
  assert.equal(calls, 2, "only one background refresh");
  gate.resolve("new");
  await tick();
  assert.equal(await swr("k", { ttlMs: 100, staleMs: 10_000, now }, compute), "new");
});

test("a value older than staleMs is not served: the caller waits for a fresh one", async () => {
  const now = clock();
  let calls = 0;
  const compute = async () => `v${++calls}`;
  assert.equal(await swr("k", { ttlMs: 100, staleMs: 1000, now }, compute), "v1");
  now.advance(5000);
  assert.equal(await swr("k", { ttlMs: 100, staleMs: 1000, now }, compute), "v2");
});

test("a failed refresh keeps serving the stale value, backs off, then retries", async () => {
  const now = clock();
  let calls = 0;
  const compute = async () => {
    calls++;
    if (calls === 2) throw new Error("db busy");
    return `v${calls}`;
  };
  const opts = { ttlMs: 100, staleMs: 100_000, now };
  assert.equal(await swr("k", opts, compute), "v1");
  now.advance(500);
  assert.equal(await swr("k", opts, compute), "v1");
  await tick();
  assert.equal(calls, 2, "the refresh failed");
  // while the database keeps failing, stale reads do not each start another scan
  assert.equal(await swr("k", opts, compute), "v1");
  await tick();
  assert.equal(calls, 2, "backing off");
  now.advance(11_000);
  assert.equal(await swr("k", opts, compute), "v1");
  await tick();
  assert.equal(await swr("k", opts, compute), "v3");
});

test("the default stale window is four times the ttl", async () => {
  const now = clock();
  let calls = 0;
  const compute = async () => `v${++calls}`;
  assert.equal(await swr("k", { ttlMs: 100, now }, compute), "v1");
  now.advance(399);
  assert.equal(await swr("k", { ttlMs: 100, now }, compute), "v1"); // stale, refresh starts
  await tick();
  now.advance(50);
  assert.equal(await swr("k", { ttlMs: 100, now }, compute), "v2"); // the refreshed value is fresh
  now.advance(401);
  assert.equal(await swr("k", { ttlMs: 100, now }, compute), "v3"); // beyond 4x ttl: waits for a new one
});

test("a cold failure reaches the caller and is not cached", async () => {
  let calls = 0;
  const compute = async () => {
    calls++;
    if (calls === 1) throw new RangeError("bad range");
    return "ok";
  };
  await assert.rejects(swr("k", { ttlMs: 1000 }, compute), RangeError);
  assert.equal(await swr("k", { ttlMs: 1000 }, compute), "ok");
  assert.equal(calls, 2);
});

test("keys are independent", async () => {
  assert.equal(await swr("a", { ttlMs: 1000 }, async () => 1), 1);
  assert.equal(await swr("b", { ttlMs: 1000 }, async () => 2), 2);
  assert.equal(await swr("a", { ttlMs: 1000 }, async () => 99), 1);
});
