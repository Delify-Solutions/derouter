// POST /api/users/[id]/keys/[keyId]/secret: the admin can copy a customer's key,
// and every copy is audited without the secret (spec admin-user-management).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-admin-key-secret-"));
// DATA_DIR must be set before the DB driver is imported.
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const { createApiKey } = await import("../src/lib/db/repos/apiKeysRepo.js");
const { revealKeySecretSync } = await import("../src/lib/billing/adminActions.js");

let db;
let mine;
let theirs;
let adminKey;
before(async () => {
  db = await getAdapter();
  mine = await createApiKey("Laptop", "machine-test", { userId: "user-a" });
  theirs = await createApiKey("Other", "machine-test", { userId: "user-b" });
  adminKey = await createApiKey("Admin", "machine-test");
});
after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const reveals = (userId) =>
  db.all(`SELECT actor, reason, details FROM userAuditLog WHERE userId = ? AND action = 'key_revealed'`, [userId]);

test("the admin gets the user's key and one audit entry without the secret", () => {
  const secret = db.transaction(() => revealKeySecretSync(db, "user-a", mine.id, { actor: "admin:ops" }));
  assert.equal(secret, mine.key);

  const rows = reveals("user-a");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor, "admin:ops");
  assert.equal(rows[0].reason, null);
  assert.deepEqual(JSON.parse(rows[0].details), { keyId: mine.id, keyName: "Laptop" });
  assert.ok(!rows[0].details.includes(mine.key));
});

test("another user's key, an admin key or an unknown id give nothing and write nothing", () => {
  const before = reveals("user-a").length;
  assert.equal(db.transaction(() => revealKeySecretSync(db, "user-a", theirs.id)), null);
  assert.equal(db.transaction(() => revealKeySecretSync(db, "user-a", adminKey.id)), null);
  assert.equal(db.transaction(() => revealKeySecretSync(db, "user-a", "no-such-id")), null);
  assert.equal(db.transaction(() => revealKeySecretSync(db, "", mine.id)), null);
  assert.equal(reveals("user-a").length, before);
  assert.equal(reveals("user-b").length, 0);
});
