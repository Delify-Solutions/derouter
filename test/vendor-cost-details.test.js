// Usage -> Details: Account column (resolves the serving connection's name) and the
// per-row profit figure (charge - vendor cost), spec admin-usage-views "Request details
// by model". Tests the route handler directly (GET /api/usage/request-details).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

register("./helpers/src-alias-hook.mjs", import.meta.url);
register("./helpers/next-server-hook.mjs", import.meta.url);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-vendor-cost-details-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const { GET } = await import("../src/app/api/usage/request-details/route.js");

let db;

before(async () => {
  db = await getAdapter();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, data, createdAt, updatedAt)
     VALUES('conn-1', 'anthropic', 'oauth', 'Claude - acc2', '{}', ?, ?)`,
    [now, now]
  );

  const detail = (id, overrides) => {
    const base = {
      id, timestamp: "2026-11-02T01:00:00.000Z", provider: "anthropic", model: "claude",
      status: "200", latency: {}, tokens: { prompt_tokens: 100, completion_tokens: 50 },
      ...overrides,
    };
    db.run(
      `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, apiKey, status, data, costNanoUsd, chargedNanoUsd, vendorCostNanoUsd)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        base.id, base.timestamp, base.provider, base.model, overrides.connectionId ?? null, null, base.status,
        JSON.stringify(base), overrides.costNanoUsd ?? null, overrides.chargedNanoUsd ?? null, overrides.vendorCostNanoUsd ?? null,
      ]
    );
  };

  detail("d-priced", { connectionId: "conn-1", costNanoUsd: 500_000, chargedNanoUsd: 500_000, vendorCostNanoUsd: 300_000 });
  detail("d-no-connection", { connectionId: null, costNanoUsd: 100_000, chargedNanoUsd: 100_000, vendorCostNanoUsd: 50_000 });
  detail("d-unpriced", { connectionId: "conn-1", costNanoUsd: 200_000, chargedNanoUsd: 200_000, vendorCostNanoUsd: null });
});

after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function fetchDetails() {
  const res = await GET(new Request("http://x/api/usage/request-details?page=1&pageSize=20&includeRaw=1"));
  const body = await res.json();
  return Object.fromEntries(body.details.map((d) => [d.id, d]));
}

test("account name resolves from the recorded connection", async () => {
  const byId = await fetchDetails();
  assert.equal(byId["d-priced"].accountName, "Claude - acc2");
});

test("a request with no recorded connection has no account name (UI renders —)", async () => {
  const byId = await fetchDetails();
  assert.equal(byId["d-no-connection"].accountName, null);
});

test("profit figure: charge minus vendor cost", async () => {
  const byId = await fetchDetails();
  const d = byId["d-priced"];
  assert.equal(d.chargedNanoUsd - d.vendorCostNanoUsd, 200_000);
});

test("missing vendor cost stays null, never coerced to 0", async () => {
  const byId = await fetchDetails();
  assert.equal(byId["d-unpriced"].vendorCostNanoUsd, null);
});
