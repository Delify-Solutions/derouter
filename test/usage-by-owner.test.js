// Admin usage grouped by customer (spec admin-user-management "Usage by customer").
// One customer may own many keys; their traffic must add up under one entry.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-usage-by-owner-"));
// DATA_DIR must be set before the DB driver is imported.
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const { createApiKey } = await import("../src/lib/db/repos/apiKeysRepo.js");
const { getUsageByOwner } = await import("../src/lib/db/repos/usageRepo.js");

let db;
let a1;
let a2;
let b1;
let idle;
let admin;

const NOW = "2026-11-01T12:00:00.000Z";

function user(id, email) {
  db.run(
    `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
     VALUES(?, ?, 'x', NULL, NULL, 'active', 0, ?, ?)`,
    [id, email, NOW, NOW]
  );
}

function row({ ts, keyId = null, rawKey = null, model = "glm", input = 10, output = 5, nano = 1000, meta = null }) {
  db.run(
    `INSERT INTO usageHistory(timestamp, provider, model, apiKey, apiKeyId, promptTokens, completionTokens, cost, costNanoUsd, status, meta)
     VALUES(?, 'p', ?, ?, ?, ?, ?, ?, ?, '200', ?)`,
    [ts, model, rawKey, keyId, input, output, nano / 1e9, nano, meta ? JSON.stringify(meta) : null]
  );
}

before(async () => {
  db = await getAdapter();
  user("u-a", "a@test.local");
  user("u-b", "b@test.local");
  user("u-idle", "idle@test.local");
  a1 = await createApiKey("A laptop", "m", { userId: "u-a" });
  a2 = await createApiKey("A server", "m", { userId: "u-a" });
  b1 = await createApiKey("B", "m", { userId: "u-b" });
  idle = await createApiKey("Idle", "m", { userId: "u-idle" });
  admin = await createApiKey("Admin", "m");

  // Customer A: two keys, same minute on both, one legacy raw-key row, one combo row.
  row({ ts: "2026-11-01T10:00:10.000Z", keyId: a1.id, input: 100, output: 50, nano: 3000 });
  row({ ts: "2026-11-01T10:00:40.000Z", keyId: a2.id, input: 200, output: 100, nano: 5000 });
  row({ ts: "2026-11-01T11:30:00.000Z", rawKey: a2.key, input: 10, output: 10, nano: 1000 });
  row({ ts: "2026-11-01T09:00:00.000Z", keyId: a1.id, model: "glm-5.3:pre", meta: { requestedModel: "GLM-5.3" }, input: 1, output: 1, nano: 0 });
  // Customer B: one key.
  row({ ts: "2026-11-01T08:00:00.000Z", keyId: b1.id, input: 5, output: 5, nano: 20000 });
  // Admin key, and a row whose key was deleted.
  row({ ts: "2026-11-01T07:00:00.000Z", keyId: admin.id, nano: 7 });
  row({ ts: "2026-11-01T06:00:00.000Z", keyId: "deleted-key", nano: 9 });
  // A request made without any key (local traffic).
  row({ ts: "2026-11-01T05:00:00.000Z", nano: 3 });
  // Outside the range below.
  row({ ts: "2026-10-01T00:00:00.000Z", keyId: a1.id, nano: 999999 });
});

after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const RANGE = { startDate: "2026-10-31T00:00:00.000Z", endDate: "2026-11-02T00:00:00.000Z" };

test("a customer's keys add up under one entry", async () => {
  const owners = await getUsageByOwner(RANGE);
  const a = owners.find((o) => o.userId === "u-a");
  assert.equal(a.email, "a@test.local");
  assert.equal(a.kind, "user");
  assert.equal(a.keyCount, 2);
  assert.equal(a.totals.requests, 4, "both keys, the legacy raw-key row included, nothing out of range");
  assert.equal(a.totals.input, 311);
  assert.equal(a.totals.output, 161);
  assert.equal(a.totals.costNanoUsd, 9000);
  assert.equal(a.lastUsedAt, "2026-11-01T11:30:00.000Z");
});

test("the busiest minute sums every key of the customer", async () => {
  const a = (await getUsageByOwner(RANGE)).find((o) => o.userId === "u-a");
  assert.equal(a.peakRpm, 2);
  assert.equal(a.peakTpm, 450);
});

test("per-key and per-model breakdowns are kept", async () => {
  const a = (await getUsageByOwner(RANGE)).find((o) => o.userId === "u-a");
  const server = a.keys.find((k) => k.id === a2.id);
  assert.equal(server.requests, 2);
  assert.equal(server.costNanoUsd, 6000);
  assert.equal(server.lastUsedAt, "2026-11-01T11:30:00.000Z");
  assert.ok(server.maskedKey.includes("****") && !server.maskedKey.includes(a2.key), "never the full key");
  assert.ok(a.byModel.some((m) => m.model === "GLM-5.3"), "grouped by the model the client asked for");
});

test("owners are sorted by cost, idle customers listed with zero", async () => {
  const owners = await getUsageByOwner(RANGE);
  assert.equal(owners[0].userId, "u-b", "B spent the most");
  const idleOwner = owners.find((o) => o.userId === "u-idle");
  assert.equal(idleOwner.totals.requests, 0);
  assert.equal(idleOwner.keyCount, 1);
  assert.equal(idleOwner.lastUsedAt, null);
});

test("admin keys and deleted keys get their own entries", async () => {
  const owners = await getUsageByOwner(RANGE);
  const adminOwner = owners.find((o) => o.kind === "admin");
  assert.equal(adminOwner.totals.requests, 2, "the admin key row and the keyless row");
  assert.ok(adminOwner.keys.some((k) => k.id === admin.id && k.requests === 1));
  const unknown = owners.find((o) => o.kind === "unknown");
  assert.equal(unknown.totals.requests, 1);
  assert.equal(unknown.keys[0].deleted, true);
});

test("a request without any key is a 'no key' line under admin, not a deleted key", async () => {
  const owners = await getUsageByOwner(RANGE);
  const adminOwner = owners.find((o) => o.kind === "admin");
  const noKey = adminOwner.keys.find((k) => k.noKey);
  assert.equal(noKey.requests, 1);
  assert.equal(adminOwner.keyCount, 1, "the no-key line is not counted as a key");
  const unknown = owners.find((o) => o.kind === "unknown");
  assert.equal(unknown.totals.requests, 1, "only the row of the deleted key");
});

test("an invalid date is refused", async () => {
  await assert.rejects(() => getUsageByOwner({ startDate: "not-a-date" }), RangeError);
});
