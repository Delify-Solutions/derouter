// Request details name the key and its owner, and filter by customer
// (spec admin-user-management "Request details show the key owner").
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-details-owner-"));
// DATA_DIR must be set before the DB driver is imported.
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const { createApiKey, describeKeysByRaw } = await import("../src/lib/db/repos/apiKeysRepo.js");
const { getRequestDetails } = await import("../src/lib/db/repos/requestDetailsRepo.js");

let db;
let a1;
let a2;
let b1;
let admin;

function detail(id, apiKey, ts) {
  db.run(
    `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, apiKey, status, data) VALUES(?, ?, 'p', 'm', NULL, ?, '200', ?)`,
    [id, ts, apiKey, JSON.stringify({ id, timestamp: ts, provider: "p", model: "m", apiKey, status: "200" })]
  );
}

before(async () => {
  db = await getAdapter();
  const now = new Date().toISOString();
  for (const [id, email] of [["u-a", "a@x.vn"], ["u-b", "b@x.vn"]]) {
    db.run(
      `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
       VALUES(?, ?, 'x', NULL, NULL, 'active', 0, ?, ?)`,
      [id, email, now, now]
    );
  }
  a1 = await createApiKey("A laptop", "m", { userId: "u-a" });
  a2 = await createApiKey("A server", "m", { userId: "u-a" });
  b1 = await createApiKey("B", "m", { userId: "u-b" });
  admin = await createApiKey("Ops", "m");
  detail("d1", a1.key, "2026-11-02T01:00:00.000Z");
  detail("d2", a2.key, "2026-11-02T02:00:00.000Z");
  detail("d3", b1.key, "2026-11-02T03:00:00.000Z");
  detail("d4", admin.key, "2026-11-02T04:00:00.000Z");
});

after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test("each raw key resolves to its name and owner; admin and unknown keys are told apart", async () => {
  const map = await describeKeysByRaw([a1.key, admin.key, "sk-gone", a1.key, null]);
  assert.equal(map[a1.key].email, "a@x.vn");
  assert.equal(map[a1.key].name, "A laptop");
  assert.equal(map[a1.key].kind, "user");
  assert.equal(map[admin.key].kind, "admin");
  assert.equal(map[admin.key].email, null);
  assert.equal(map["sk-gone"], undefined);
  assert.deepEqual(await describeKeysByRaw([]), {});
});

test("filtering by user returns every key of that customer and nothing else", async () => {
  const { details } = await getRequestDetails({ userId: "u-a", page: 1, pageSize: 20 });
  assert.deepEqual(details.map((d) => d.id).sort(), ["d1", "d2"]);
  const none = await getRequestDetails({ userId: "nobody", page: 1, pageSize: 20 });
  assert.equal(none.details.length, 0);
});

test("a request keeps its owner after the key is deleted (snapshot at request time)", async () => {
  const { updateSettings } = await import("../src/lib/db/repos/settingsRepo.js");
  const { saveRequestDetail } = await import("../src/lib/db/repos/requestDetailsRepo.js");
  const { deleteApiKey } = await import("../src/lib/db/repos/apiKeysRepo.js");
  // Flush on every save so the test does not wait for the timer. The env switch
  // overrides the settings, so a shell with ENABLE_REQUEST_LOGS=false must not
  // turn logging off here.
  delete process.env.ENABLE_REQUEST_LOGS;
  await updateSettings({ enableObservability: true, observabilityBatchSize: 1 });

  const doomed = await createApiKey("A old laptop", "m", { userId: "u-a" });
  await saveRequestDetail({
    id: "d-snap", provider: "p", model: "m", apiKey: doomed.key, status: "200",
    timestamp: "2026-11-02T05:00:00.000Z",
  });
  for (let i = 0; i < 100 && !db.get(`SELECT 1 AS x FROM requestDetails WHERE id = 'd-snap'`); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const row = db.get(`SELECT userId, apiKeyId FROM requestDetails WHERE id = 'd-snap'`);
  assert.deepEqual({ ...row }, { userId: "u-a", apiKeyId: doomed.id });

  await deleteApiKey(doomed.id);
  // The live lookup no longer knows the key...
  assert.equal((await describeKeysByRaw([doomed.key]))[doomed.key], undefined);
  // ...but the row still belongs to u-a for the per-customer filter,
  const { details } = await getRequestDetails({ userId: "u-a", page: 1, pageSize: 20 });
  assert.ok(details.some((d) => d.id === "d-snap"), "deleted key's request still listed for its owner");
  // and the stored record names the owner for the admin view.
  const snap = details.find((d) => d.id === "d-snap").owner;
  assert.equal(snap.email, "a@x.vn");
  assert.equal(snap.keyName, "A old laptop");
  const other = await getRequestDetails({ userId: "u-b", page: 1, pageSize: 20 });
  assert.ok(!other.details.some((d) => d.id === "d-snap"));
});

test("deleting the account drops the owner snapshot from its request logs", async () => {
  const { deleteUser } = await import("../src/lib/db/repos/userRepo.js");
  assert.equal(db.get(`SELECT userId FROM requestDetails WHERE id = 'd-snap'`).userId, "u-a");
  await deleteUser("u-a", { actor: "admin:test" });
  const row = db.get(`SELECT userId, apiKeyId, data FROM requestDetails WHERE id = 'd-snap'`);
  assert.equal(row.userId, null);
  assert.equal(row.apiKeyId, null);
  assert.equal(JSON.parse(row.data).owner, undefined);
  assert.doesNotMatch(row.data, /a@x\.vn/);
});
