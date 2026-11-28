// Admin accounts (spec admin-accounts): schema/migration, login credentials,
// per-account session revocation, self-service password change and the
// view/edit/delete permission matrix.
//
// Everything here runs against a real throwaway SQLite database (same pattern as
// test/skills.test.js): adminUsers.js uses only relative imports, so it is
// importable directly under plain `node --test`.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-admin-accounts-test-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const adminAccountsMigration = (await import("../src/lib/db/migrations/008-admin-accounts.js")).default;
const adminUsers = await import("../src/lib/auth/adminUsers.js");
const { ADMIN_PAGES, PAGE_KEYS, resolvePageKeyFromPath } = await import("../src/lib/auth/adminPages.js");

let db;

function reset() {
  for (const t of ["adminPermissions", "adminUsers", "settings"]) {
    try { db.run(`DELETE FROM ${t}`); } catch { /* table may not exist yet */ }
  }
}

before(async () => {
  db = await getAdapter();
  reset();
});

after(() => {
  try { db.close?.(); } catch { /* best effort */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => reset());

// ── Migration 008: Super Admin backfill ────────────────────────────────────

test("migration creates exactly one Super Admin from settings.password, and is idempotent", () => {
  db.run(`INSERT INTO settings(id, data) VALUES(1, ?)`, [JSON.stringify({ password: "legacy-hash-value" })]);

  adminAccountsMigration.up(db);
  adminAccountsMigration.up(db); // second run must not create a second row

  const rows = db.all(`SELECT * FROM adminUsers WHERE role = 'super_admin'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].username, "admin");
  assert.equal(rows[0].passwordHash, "legacy-hash-value");
  assert.equal(Number(rows[0].mustChangePassword), 0);
});

test("migration on a fresh DB (no settings.password yet) still produces exactly one Super Admin, with NULL passwordHash", () => {
  // No settings row at all — the true fresh-install case (settings is itself
  // created by the additive sync that runs AFTER this migration).
  db.run(`DELETE FROM settings`);
  adminAccountsMigration.up(db);

  const rows = db.all(`SELECT * FROM adminUsers WHERE role = 'super_admin'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].username, "admin");
  assert.equal(rows[0].passwordHash, null);
});

// ── Credentials ─────────────────────────────────────────────────────────────

function seedSuperAdmin({ passwordHash = null } = {}) {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO adminUsers(id, username, passwordHash, displayName, role, status, mustChangePassword, sessionsValidAfter, createdAt, updatedAt)
     VALUES('super-1', 'admin', ?, 'Super Admin', 'super_admin', 'active', 0, 0, ?, ?)`,
    [passwordHash, now, now]
  );
}

test("Super Admin with no password yet falls back to the default/INITIAL_PASSWORD, same as the single-password flow", async () => {
  seedSuperAdmin({ passwordHash: null });
  delete process.env.INITIAL_PASSWORD;

  const ok = await adminUsers.verifyAdminCredentials("admin", "123456");
  assert.equal(ok.ok, true);
  assert.equal(ok.legacyDefaultPassword, true);

  const wrong = await adminUsers.verifyAdminCredentials("admin", "wrong");
  assert.equal(wrong.ok, false);
});

test("unknown username and wrong password for a real username are indistinguishable", async () => {
  await adminUsers.createAdminAccount({ username: "ctv_hoa", password: "correct-horse", role: "member" });

  const unknownUser = await adminUsers.verifyAdminCredentials("no_such_user", "whatever");
  const wrongPass = await adminUsers.verifyAdminCredentials("ctv_hoa", "whatever");
  assert.equal(unknownUser.ok, false);
  assert.equal(wrongPass.ok, false);
  assert.equal("disabled" in unknownUser, false);
  assert.equal("disabled" in wrongPass, false);
});

test("a disabled account is refused at login with a distinct 'disabled' signal", async () => {
  const account = await adminUsers.createAdminAccount({ username: "ctv_disabled", password: "correct-horse", role: "member" });
  await adminUsers.updateAdminAccount(account.id, { status: "disabled" });

  const result = await adminUsers.verifyAdminCredentials("ctv_disabled", "correct-horse");
  assert.equal(result.ok, false);
  assert.equal(result.disabled, true);
});

test("disabling an account immediately revokes its sessions (sessionsValidAfter bumped to now)", async () => {
  const account = await adminUsers.createAdminAccount({ username: "ctv_revoke", password: "correct-horse", role: "member" });
  const before = await adminUsers.findAdminAccountById(account.id);
  assert.equal(before.sessionsValidAfter, 0);

  await adminUsers.updateAdminAccount(account.id, { status: "disabled" });
  const after = await adminUsers.findAdminAccountById(account.id);
  assert.ok(after.sessionsValidAfter > 0, "sessionsValidAfter must move to a real unix-seconds value");
});

// ── Account creation / protection ──────────────────────────────────────────

test("username must be 3-32 chars of letters/digits/_/-", async () => {
  await assert.rejects(
    () => adminUsers.createAdminAccount({ username: "ab", password: "longenough1", role: "member" }),
    /invalid_username|Tên đăng nhập/
  );
  await assert.rejects(
    () => adminUsers.createAdminAccount({ username: "has space", password: "longenough1", role: "member" }),
  );
});

test("username uniqueness is case-insensitive (spec 'Username already taken')", async () => {
  await adminUsers.createAdminAccount({ username: "ctv_Linh", password: "longenough1", role: "member" });
  await assert.rejects(
    () => adminUsers.createAdminAccount({ username: "CTV_linh", password: "longenough1", role: "member" }),
    (err) => err.code === "username_taken"
  );
});

test("the Super Admin account can never be edited or deleted through the account-management path", async () => {
  seedSuperAdmin({ passwordHash: "x" });
  await assert.rejects(
    () => adminUsers.updateAdminAccount("super-1", { status: "disabled" }),
    (err) => err.code === "super_admin_protected"
  );
  await assert.rejects(
    () => adminUsers.deleteAdminAccount("super-1"),
    (err) => err.code === "super_admin_protected"
  );
  await assert.rejects(
    () => adminUsers.setAdminPermissions("super-1", { orders: { view: true, edit: true, delete: false } }),
    (err) => err.code === "super_admin_protected"
  );
});

// ── Self-service password change ───────────────────────────────────────────

test("wrong current password is rejected and nothing changes", async () => {
  const account = await adminUsers.createAdminAccount({ username: "ctv_pw", password: "correct-horse", role: "member" });
  await assert.rejects(
    () => adminUsers.changeOwnPassword(account.id, { currentPassword: "nope", newPassword: "newpassword1" }),
    (err) => err.code === "wrong_password"
  );
  const stillWorks = await adminUsers.verifyAdminCredentials("ctv_pw", "correct-horse");
  assert.equal(stillWorks.ok, true);
});

test("a successful password change clears mustChangePassword and revokes sessions issued before it", async () => {
  const account = await adminUsers.createAdminAccount({ username: "ctv_first", password: "temp-password1", role: "member" });
  assert.equal((await adminUsers.findAdminAccountById(account.id)).mustChangePassword, true);

  await adminUsers.changeOwnPassword(account.id, { currentPassword: "temp-password1", newPassword: "real-password1" });

  const after = await adminUsers.findAdminAccountById(account.id);
  assert.equal(after.mustChangePassword, false);
  assert.ok(after.sessionsValidAfter > 0);

  const oldPasswordRejected = await adminUsers.verifyAdminCredentials("ctv_first", "temp-password1");
  assert.equal(oldPasswordRejected.ok, false);
  const newPasswordWorks = await adminUsers.verifyAdminCredentials("ctv_first", "real-password1");
  assert.equal(newPasswordWorks.ok, true);
});

// ── Permission matrix ───────────────────────────────────────────────────────

test("edit or delete without view is rejected, and nothing is written", async () => {
  const account = await adminUsers.createAdminAccount({ username: "ctv_matrix", password: "correct-horse", role: "member" });
  await assert.rejects(
    () => adminUsers.setAdminPermissions(account.id, { orders: { view: false, edit: true, delete: false } }),
    (err) => err.code === "edit_without_view"
  );
  const matrix = await adminUsers.getAdminPermissions(account.id);
  assert.deepEqual(matrix, {});
});

test("a view-only collaborator matrix round-trips exactly", async () => {
  const account = await adminUsers.createAdminAccount({ username: "ctv_scoped", password: "correct-horse", role: "member" });
  await adminUsers.setAdminPermissions(account.id, {
    orders: { view: true, edit: true, delete: false },
    usage: { view: true, edit: false, delete: false },
  });

  const ordersPerm = await adminUsers.getAdminPermissionForPage(account.id, "orders");
  assert.deepEqual(ordersPerm, { pageKey: "orders", view: true, edit: true, delete: false });

  const usagePerm = await adminUsers.getAdminPermissionForPage(account.id, "usage");
  assert.deepEqual(usagePerm, { pageKey: "usage", view: true, edit: false, delete: false });

  // A page never granted reads as all-false, not "missing".
  const plansPerm = await adminUsers.getAdminPermissionForPage(account.id, "plans");
  assert.deepEqual(plansPerm, { pageKey: "plans", view: false, edit: false, delete: false });
});

test("re-setting the matrix replaces it wholesale, not merges", async () => {
  const account = await adminUsers.createAdminAccount({ username: "ctv_replace", password: "correct-horse", role: "member" });
  await adminUsers.setAdminPermissions(account.id, { orders: { view: true, edit: true, delete: true } });
  await adminUsers.setAdminPermissions(account.id, { usage: { view: true, edit: false, delete: false } });

  const matrix = await adminUsers.getAdminPermissions(account.id);
  assert.deepEqual(Object.keys(matrix), ["usage"]);
});

// ── Page registry ────────────────────────────────────────────────────────

test("the registry lists every page key named in spec admin-accounts (32 existing pages plus admin-accounts), each unique", () => {
  // Spec "Admin page permission matrix" enumerates 32 existing page keys
  // (dashboard, affiliates, ..., users) plus this capability's own
  // admin-accounts — 33 keys total. (tasks.md's "31 existing pages" summary
  // undercounts its own enumerated list by one; the enumerated list is ground truth.)
  // +1 (34): change cache-miss-auto-refund registered its own admin page
  // ("cache-refunds") after this spec was written — the count here tracks the
  // registry as it stands, not a frozen historical total.
  assert.equal(PAGE_KEYS.length, 34);
  assert.equal(new Set(PAGE_KEYS).size, 34);
  assert.ok(PAGE_KEYS.includes("admin-accounts"));
});

test("resolvePageKeyFromPath resolves the longest matching prefix", () => {
  assert.equal(resolvePageKeyFromPath("/dashboard"), "dashboard");
  assert.equal(resolvePageKeyFromPath("/dashboard/orders"), "orders");
  assert.equal(resolvePageKeyFromPath("/dashboard/orders/123"), "orders");
  assert.equal(resolvePageKeyFromPath("/dashboard/media-providers/tts"), "media-providers");
  assert.equal(resolvePageKeyFromPath("/dashboard/admin-accounts"), "admin-accounts");
  assert.equal(resolvePageKeyFromPath("/dashboard/no-such-page"), null);
  assert.equal(resolvePageKeyFromPath("/not-dashboard"), null);
});

test("every registered page has a unique pathPrefix", () => {
  const prefixes = ADMIN_PAGES.map((p) => p.pathPrefix);
  assert.equal(new Set(prefixes).size, prefixes.length);
});
