// Usage -> Providers: cache-hit ratio and per-connection breakdown (spec
// admin-usage-views "Provider cache ratio and per-connection breakdown"). Exercises both
// the raw path and the hourly-rollup path (usageRollupProvider widened to
// (hour, provider, connectionId)), per the project's usage-dashboard-perf convention of
// checking a backfilled hour's figures against a raw scan of the same hour as an oracle.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-vendor-cost-providers-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const { getProviderUsageSummary } = await import("../src/lib/db/repos/usageRepo.js");
const { advanceOneHourSync } = await import("../src/lib/db/repos/usageRollup.js");

let db;
const HOUR = 3_600_000;
const NOW = Date.now();
// Well inside a single complete hour, safely past the rollup lag window (30 min).
const HOUR_START = Math.floor((NOW - 3 * HOUR) / HOUR) * HOUR;
const iso = (ms) => new Date(ms).toISOString();

before(async () => {
  db = await getAdapter();
  const now = iso(NOW);
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, data, createdAt, updatedAt)
     VALUES('conn-a', 'openrouter', 'oauth', 'Claude - acc1', '{}', ?, ?),
           ('conn-b', 'openrouter', 'oauth', 'Claude - acc2', '{}', ?, ?)`,
    [now, now, now, now]
  );

  const insert = (connectionId, prompt, completion, cacheRead, vendorCostNanoUsd, offsetMs) => {
    db.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, promptTokens, completionTokens, costNanoUsd, status, tokens, vendorCostNanoUsd)
       VALUES(?, 'openrouter', 'glm-5', ?, ?, ?, ?, 'ok', ?, ?)`,
      [
        iso(HOUR_START + offsetMs), connectionId, prompt, completion, (prompt + completion) * 1000,
        JSON.stringify({ prompt_tokens: prompt, completion_tokens: completion, cached_tokens: cacheRead }),
        vendorCostNanoUsd,
      ]
    );
  };

  // conn-a: 2 requests, 250k of 1,000,000 input tokens are cache reads; both priced.
  insert("conn-a", 500_000, 100, 250_000, 100_000, 1000);
  insert("conn-a", 500_000, 100, 0, 100_000, 2000);
  // conn-b: 1 request, no cache, unpriced.
  insert("conn-b", 200_000, 50, 0, null, 3000);

  // Roll up everything that has aged past the lag window.
  while (advanceOneHourSync(db, NOW)) { /* roll */ }
});

after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function findOpenrouter(items) {
  return items.find((it) => it.provider === "openrouter");
}

test("cache-hit ratio computed correctly (rollup path)", async () => {
  const { items } = await getProviderUsageSummary({ startDate: iso(HOUR_START - 1), endDate: iso(HOUR_START + HOUR), useRollup: true });
  const p = findOpenrouter(items);
  // Total input = 1,200,000; cache reads = 250,000 => 20.833...%
  assert.equal(p.input, 1_200_000);
  assert.ok(Math.abs(p.cacheHitRatio - 250_000 / 1_200_000) < 1e-9);
});

test("a provider with two connections expands to rows that sum back to the provider's totals", async () => {
  const { items } = await getProviderUsageSummary({ startDate: iso(HOUR_START - 1), endDate: iso(HOUR_START + HOUR), useRollup: true });
  const p = findOpenrouter(items);
  assert.equal(p.breakdown.length, 2);
  const sum = (field) => p.breakdown.reduce((s, c) => s + (c[field] || 0), 0);
  assert.equal(sum("requests"), p.requests);
  assert.equal(sum("input"), p.input);
  assert.equal(sum("output"), p.output);
  assert.equal(sum("cacheRead"), p.cacheRead);
  assert.equal(sum("vendorCostNanoUsd"), p.vendorCostNanoUsd);
  assert.equal(sum("pricedRequests"), p.pricedRequests);

  const connA = p.breakdown.find((c) => c.connectionId === "conn-a");
  assert.equal(connA.accountName, "Claude - acc1");
  assert.equal(connA.pricedRequests, 2);
  assert.equal(connA.vendorCostNanoUsd, 200_000);

  const connB = p.breakdown.find((c) => c.connectionId === "conn-b");
  assert.equal(connB.accountName, "Claude - acc2");
  assert.equal(connB.pricedRequests, 0);
  assert.equal(connB.profitNanoUsd, null, "no priced requests: no profit figure, not a fabricated 0");
});

test("a provider with zero input tokens shows no cache ratio (null, not a divide-by-zero)", async () => {
  // A fresh, still-unrolled row: read via the raw path (useRollup: false) so this does
  // not depend on re-rolling an hour the earlier tests already rolled without it.
  db.run(
    `INSERT INTO usageHistory(timestamp, provider, model, connectionId, promptTokens, completionTokens, costNanoUsd, status, tokens)
     VALUES(?, 'zero-input', 'm', NULL, 0, 0, 0, 'ok', '{}')`,
    [iso(NOW - 1000)]
  );
  const { items } = await getProviderUsageSummary({ startDate: iso(NOW - HOUR), endDate: iso(NOW), useRollup: false });
  const p = items.find((it) => it.provider === "zero-input");
  assert.ok(p, "zero-input provider row should exist");
  assert.equal(p.input, 0);
  assert.equal(p.cacheHitRatio, null);
});

test("oracle: the rollup path's per-connection breakdown matches a raw scan of the same hour", async () => {
  const range = { startDate: iso(HOUR_START - 1), endDate: iso(HOUR_START + HOUR) };
  const rolled = (await getProviderUsageSummary({ ...range, useRollup: true })).items.find((it) => it.provider === "openrouter");
  const raw = (await getProviderUsageSummary({ ...range, useRollup: false })).items.find((it) => it.provider === "openrouter");

  const normalize = (p) => ({
    requests: p.requests, input: p.input, output: p.output, cacheRead: p.cacheRead, cacheCreation: p.cacheCreation,
    vendorCostNanoUsd: p.vendorCostNanoUsd, pricedRequests: p.pricedRequests,
    breakdown: [...p.breakdown].sort((a, b) => String(a.connectionId).localeCompare(String(b.connectionId)))
      .map((c) => ({ connectionId: c.connectionId, requests: c.requests, input: c.input, output: c.output, cacheRead: c.cacheRead, vendorCostNanoUsd: c.vendorCostNanoUsd, pricedRequests: c.pricedRequests })),
  });
  assert.deepEqual(normalize(rolled), normalize(raw));
});
