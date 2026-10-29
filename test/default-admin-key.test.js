// The dashboard has no screen to create admin keys, so the server keeps exactly one
// "Default Key" for tools and examples to point at.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-defaultkey-test-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const keys = await import("../src/lib/db/repos/apiKeysRepo.js");

let db;
before(async () => { db = await getAdapter(); });
after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const adminKeys = () => db.all(`SELECT * FROM apiKeys WHERE userId IS NULL`);

test("creates one Default Key when there is no admin key, and only one", async () => {
  assert.equal(adminKeys().length, 0);
  const created = await keys.ensureDefaultAdminKey("machine-1");
  assert.equal(created.name, "Default Key");
  assert.equal(created.groupId, null);
  assert.equal(adminKeys().length, 1);

  assert.equal(await keys.ensureDefaultAdminKey("machine-1"), null);
  assert.equal(adminKeys().length, 1);
});

test("concurrent calls still create a single key", async () => {
  db.run(`DELETE FROM apiKeys`);
  await Promise.all([1, 2, 3, 4].map(() => keys.ensureDefaultAdminKey("machine-1")));
  assert.equal(adminKeys().length, 1);
});

test("a customer key does not count as an admin key", async () => {
  db.run(`DELETE FROM apiKeys`);
  db.run(
    `INSERT INTO users(id, email, passwordHash, status, overdraftNanoUsd, createdAt, updatedAt) VALUES('u1', 'u@x.y', 'x', 'active', 0, ?, ?)`,
    [new Date().toISOString(), new Date().toISOString()]
  );
  await keys.createApiKey("mine", "machine-1", { userId: "u1" });
  assert.equal(adminKeys().length, 0);
  await keys.ensureDefaultAdminKey("machine-1");
  assert.equal(adminKeys().length, 1);
});

test("a key never gets a group, whatever the caller passes", async () => {
  db.run(`DELETE FROM apiKeys`);
  const key = await keys.createApiKey("x", "machine-1", { groupId: "anything" });
  assert.equal(key.groupId, null);
  const updated = await keys.updateApiKey(key.id, { groupId: "something", rpm: 5 });
  assert.equal(updated.groupId, null);
  assert.equal(updated.rpm, 5);
});
