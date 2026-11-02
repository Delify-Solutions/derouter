// POST /api/account/keys/{id}/secret hands a key only to its owner
// (spec customer-portal "API key page").
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-key-secret-"));
// DATA_DIR must be set before the DB driver is imported.
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const { createApiKey } = await import("../src/lib/db/repos/apiKeysRepo.js");
const { getOwnedKeySecret } = await import("../src/lib/account/keySecret.js");

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

test("the owner gets the full key", async () => {
  assert.equal(await getOwnedKeySecret("user-a", mine.id), mine.key);
});

test("another customer's key gives nothing", async () => {
  assert.equal(await getOwnedKeySecret("user-a", theirs.id), null);
});

test("a key with no owner (admin key) gives nothing", async () => {
  assert.equal(await getOwnedKeySecret("user-a", adminKey.id), null);
});

test("an unknown id or a missing user gives nothing", async () => {
  assert.equal(await getOwnedKeySecret("user-a", "no-such-id"), null);
  assert.equal(await getOwnedKeySecret("", mine.id), null);
  assert.equal(await getOwnedKeySecret("user-a", ""), null);
});
