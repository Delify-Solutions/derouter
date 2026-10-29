// Turning email verification off releases accounts that signed up while it was on
// (spec customer-auth: verification is decided at signup, so the toggle alone
// would leave them locked out).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-activate-test-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const users = await import("../src/lib/db/repos/userRepo.js");

let db;
before(async () => { db = await getAdapter(); });
after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test("activateUnverifiedUsers activates only unverified accounts", async () => {
  const waiting = await users.createUser({ email: "a@example.com", passwordHash: "x", status: "unverified" });
  const suspended = await users.createUser({ email: "b@example.com", passwordHash: "x", status: "suspended" });
  const active = await users.createUser({ email: "c@example.com", passwordHash: "x", status: "active" });

  assert.equal(await users.activateUnverifiedUsers(), 1);
  assert.equal((await users.getUserById(waiting.id)).status, "active");
  assert.equal((await users.getUserById(suspended.id)).status, "suspended");
  assert.equal((await users.getUserById(active.id)).status, "active");
  assert.equal(await users.activateUnverifiedUsers(), 0);
});
