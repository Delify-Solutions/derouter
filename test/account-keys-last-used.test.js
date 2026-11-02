// "Last used" on the customer key list (spec customer-portal "API key page").
//
// A key's history is stored in two row shapes: legacy rows carry the raw key in
// usageHistory.apiKey, newer rows carry apiKeyId. The last-used time must look at
// both and never mix up two keys.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-keys-last-used-"));
// DATA_DIR must be set before the DB driver is imported.
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const { getKeysLastUsedAt } = await import("../src/lib/db/repos/usageRepo.js");

let db;
before(async () => { db = await getAdapter(); });
after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(() => { db.run(`DELETE FROM usageHistory`); });

function row({ ts, apiKey = null, apiKeyId = null }) {
  db.run(
    `INSERT INTO usageHistory(timestamp, provider, model, apiKey, apiKeyId, promptTokens, completionTokens, cost, costNanoUsd, status)
     VALUES(?, 'p', 'm', ?, ?, 1, 1, 0, 0, '200')`,
    [ts, apiKey, apiKeyId]
  );
}

const A = { id: "key-a", key: "sk-aaaaaaaa-secret" };
const B = { id: "key-b", key: "sk-bbbbbbbb-secret" };

test("the newest row wins, read from apiKeyId rows", async () => {
  row({ ts: "2026-10-30T01:00:00.000Z", apiKeyId: A.id });
  row({ ts: "2026-11-01T13:53:00.000Z", apiKeyId: A.id });
  const out = await getKeysLastUsedAt([A]);
  assert.equal(out[A.id], "2026-11-01T13:53:00.000Z");
});

test("legacy raw-key rows count, and the later of the two shapes wins", async () => {
  row({ ts: "2026-10-31T09:00:00.000Z", apiKey: A.key });
  row({ ts: "2026-10-29T09:00:00.000Z", apiKeyId: A.id });
  assert.equal((await getKeysLastUsedAt([A]))[A.id], "2026-10-31T09:00:00.000Z");

  row({ ts: "2026-11-01T00:00:00.000Z", apiKeyId: A.id });
  assert.equal((await getKeysLastUsedAt([A]))[A.id], "2026-11-01T00:00:00.000Z");
});

test("each key gets its own time; a key with no rows is null", async () => {
  row({ ts: "2026-11-01T05:00:00.000Z", apiKeyId: A.id });
  row({ ts: "2026-11-01T06:00:00.000Z", apiKeyId: "someone-else" });
  const out = await getKeysLastUsedAt([A, B]);
  assert.equal(out[A.id], "2026-11-01T05:00:00.000Z");
  assert.equal(out[B.id], null);
});

test("a key listed without its raw value is read by id only", async () => {
  row({ ts: "2026-11-01T07:00:00.000Z", apiKey: A.key });
  const out = await getKeysLastUsedAt([{ id: A.id }]);
  assert.equal(out[A.id], null);
});

test("no keys is an empty map", async () => {
  assert.deepEqual(await getKeysLastUsedAt([]), {});
});
