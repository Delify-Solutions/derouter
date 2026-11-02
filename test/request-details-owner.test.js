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
