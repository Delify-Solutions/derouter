// Named admin dashboard accounts (spec admin-accounts), replacing the single
// shared `settings.password`. Exactly one `super_admin` account always exists —
// created by migration 008 from the legacy settings.password — and it is never
// deleted, disabled, demoted or permission-checked.
//
// Relative imports only: this module is imported directly by plain `node --test`
// (no `@/` alias, no bare `open-sse/...`). Dynamic/aliased imports belong in the
// Next.js route handlers that call this module, not in here.
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { getAdapter } from "../db/driver.js";

const DEFAULT_PASSWORD = "123456";
const USERNAME_PATTERN = /^[A-Za-z0-9_-]{3,32}$/;
const PAGE_KEY_PATTERN = /^[a-z][a-z0-9-]*$/;

// Precomputed once, compared against for an unknown username so the response
// time and shape never reveal whether the username was real (spec "Unknown
// username", design decision 5).
let dummyHashPromise = null;
function dummyHash() {
  if (!dummyHashPromise) dummyHashPromise = bcrypt.hash("not-a-real-password-xyz", 10);
  return dummyHashPromise;
}

function nowIso() {
  return new Date().toISOString();
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

export function isValidUsername(username) {
  return typeof username === "string" && USERNAME_PATTERN.test(username);
}

export function isValidPageKey(key) {
  return typeof key === "string" && PAGE_KEY_PATTERN.test(key);
}

function rowToAccount(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName ?? row.username,
    role: row.role,
    status: row.status,
    mustChangePassword: Number(row.mustChangePassword) === 1,
    sessionsValidAfter: Number(row.sessionsValidAfter) || 0,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

/** Full row including passwordHash — never sent to a client. */
async function getRawByUsername(db, username) {
  return db.get(`SELECT * FROM adminUsers WHERE LOWER(username) = LOWER(?)`, [String(username || "")]);
}

export async function findAdminAccountByUsername(username) {
  if (!username) return null;
  const db = await getAdapter();
  return rowToAccount(await getRawByUsername(db, username));
}

export async function findAdminAccountById(id) {
  if (!id) return null;
  const db = await getAdapter();
  return rowToAccount(db.get(`SELECT * FROM adminUsers WHERE id = ?`, [id]));
}

export async function getSuperAdminAccount() {
  const db = await getAdapter();
  return rowToAccount(db.get(`SELECT * FROM adminUsers WHERE role = 'super_admin' LIMIT 1`));
}

export async function listAdminAccounts() {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT * FROM adminUsers ORDER BY CASE WHEN role = 'super_admin' THEN 0 ELSE 1 END, createdAt ASC`
  );
  return rows.map(rowToAccount);
}

export function isSuperAdminSession(session) {
  return !!session && session.role === "super_admin";
}

/**
 * Compare a password against an account's hash. NULL hash (fresh-install Super
 * Admin, before any password was ever set) falls back to INITIAL_PASSWORD / the
 * "123456" default — the exact behavior the single-password flow already had.
 */
async function verifyPasswordHash(password, hash) {
  if (!hash) {
    const initial = process.env.INITIAL_PASSWORD || DEFAULT_PASSWORD;
    return typeof password === "string" && password === initial;
  }
  if (typeof password !== "string" || !password) return false;
  return bcrypt.compare(password, hash);
}

/**
 * Verify {username, password} against adminUsers.
 *
 * @returns {Promise<{ok:boolean, account?:object, disabled?:boolean}>}
 */
export async function verifyAdminCredentials(username, password) {
  const db = await getAdapter();
  const row = await getRawByUsername(db, username);
  if (!row) {
    // Pay the same bcrypt cost an existing username would, so timing cannot
    // distinguish "no such user" from "wrong password".
    await bcrypt.compare(typeof password === "string" ? password : "", await dummyHash());
    return { ok: false };
  }
  const ok = await verifyPasswordHash(password, row.passwordHash);
  if (!ok) return { ok: false };
  if (row.status !== "active") return { ok: false, disabled: true, account: rowToAccount(row) };
  // true only for the fresh-install Super Admin whose password has never been
  // set for real (NULL passwordHash) — the single source of truth the login
  // route's legacy "default password, remote access" gate reads, instead of the
  // (possibly stale once a password is set only through this module) settings.password.
  return { ok: true, account: rowToAccount(row), legacyDefaultPassword: !row.passwordHash };
}

/** Bumps sessionsValidAfter to now — every token issued before this instant is rejected. */
export function revokeAdminAccountSessionsSync(db, adminUserId, { now = nowSeconds() } = {}) {
  db.run(`UPDATE adminUsers SET sessionsValidAfter = ?, updatedAt = ? WHERE id = ?`, [now, nowIso(), adminUserId]);
}

export function createAdminAccountSync(
  db,
  { username, password, displayName, role = "member" } = {}
) {
  if (!isValidUsername(username)) {
    const e = new Error("Tên đăng nhập phải dài 3-32 ký tự, chỉ gồm chữ/số/_/-");
    e.code = "invalid_username";
    throw e;
  }
  if (typeof password !== "string" || password.length < 8) {
    const e = new Error("Mật khẩu tối thiểu 8 ký tự");
    e.code = "invalid_password";
    throw e;
  }
  const existing = db.get(`SELECT id FROM adminUsers WHERE LOWER(username) = LOWER(?)`, [username]);
  if (existing) {
    const e = new Error("Tên đăng nhập đã tồn tại");
    e.code = "username_taken";
    throw e;
  }
  const id = crypto.randomUUID();
  const now = nowIso();
  const passwordHash = bcrypt.hashSync(password, bcrypt.genSaltSync(10));
  db.run(
    `INSERT INTO adminUsers(id, username, passwordHash, displayName, role, status, mustChangePassword, sessionsValidAfter, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, 'active', 1, 0, ?, ?)`,
    [id, username, passwordHash, displayName?.trim() || username, role === "super_admin" ? "member" : role, now, now]
  );
  return id;
}

export async function createAdminAccount(input) {
  const db = await getAdapter();
  let id = null;
  db.transaction(() => {
    id = createAdminAccountSync(db, input);
  });
  return findAdminAccountById(id);
}

/**
 * Update display name / status / force-password-reset for a `member` account.
 * The Super Admin row can never be edited through this path (spec "Exactly one
 * super_admin account... cannot be deleted, disabled, demoted, or have its
 * permissions edited").
 */
export function updateAdminAccountSync(
  db,
  id,
  { displayName, status, mustChangePassword, newPassword } = {}
) {
  const row = db.get(`SELECT * FROM adminUsers WHERE id = ?`, [id]);
  if (!row) {
    const e = new Error("Không tìm thấy tài khoản");
    e.code = "not_found";
    throw e;
  }
  if (row.role === "super_admin") {
    const e = new Error("Không thể chỉnh sửa tài khoản Super Admin");
    e.code = "super_admin_protected";
    throw e;
  }

  const next = { ...row };
  if (displayName !== undefined) next.displayName = String(displayName).trim() || row.username;
  if (status !== undefined) {
    if (status !== "active" && status !== "disabled") {
      const e = new Error("Trạng thái không hợp lệ");
      e.code = "invalid_status";
      throw e;
    }
    next.status = status;
  }
  if (mustChangePassword !== undefined) next.mustChangePassword = mustChangePassword ? 1 : 0;
  if (newPassword !== undefined) {
    if (typeof newPassword !== "string" || newPassword.length < 8) {
      const e = new Error("Mật khẩu tối thiểu 8 ký tự");
      e.code = "invalid_password";
      throw e;
    }
    next.passwordHash = bcrypt.hashSync(newPassword, bcrypt.genSaltSync(10));
    next.mustChangePassword = 1;
  }
  next.updatedAt = nowIso();

  db.run(
    `UPDATE adminUsers SET displayName = ?, status = ?, mustChangePassword = ?, passwordHash = ?, updatedAt = ? WHERE id = ?`,
    [next.displayName, next.status, next.mustChangePassword, next.passwordHash, next.updatedAt, id]
  );
  // Disabling (or force-resetting) revokes every open session for this account
  // immediately — the same instant a status/password change takes effect.
  if (status === "disabled" || newPassword !== undefined) {
    revokeAdminAccountSessionsSync(db, id);
  }
  return id;
}

export async function updateAdminAccount(id, patch) {
  const db = await getAdapter();
  db.transaction(() => {
    updateAdminAccountSync(db, id, patch);
  });
  return findAdminAccountById(id);
}

export async function deleteAdminAccount(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM adminUsers WHERE id = ?`, [id]);
  if (!row) return false;
  if (row.role === "super_admin") {
    const e = new Error("Không thể xoá tài khoản Super Admin");
    e.code = "super_admin_protected";
    throw e;
  }
  db.transaction(() => {
    db.run(`DELETE FROM adminPermissions WHERE adminUserId = ?`, [id]);
    db.run(`DELETE FROM adminUsers WHERE id = ?`, [id]);
  });
  return true;
}

/**
 * Change an account's own password (self-service). Clears mustChangePassword
 * and revokes every OTHER open session — the caller re-issues a fresh cookie
 * for the current one, same pattern as PATCH /api/settings's password change.
 *
 * bcrypt compare/hash are awaited here, BEFORE the transaction opens: a
 * db.transaction callback must stay synchronous (never `await` inside one), so
 * only the plain writes below run inside it.
 */
export async function changeOwnPassword(id, input) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM adminUsers WHERE id = ?`, [id]);
  if (!row) {
    const e = new Error("Không tìm thấy tài khoản");
    e.code = "not_found";
    throw e;
  }
  const ok = await verifyPasswordHash(input?.currentPassword, row.passwordHash);
  if (!ok) {
    const e = new Error("Mật khẩu hiện tại không đúng");
    e.code = "wrong_password";
    throw e;
  }
  if (typeof input?.newPassword !== "string" || input.newPassword.length < 8) {
    const e = new Error("Mật khẩu mới tối thiểu 8 ký tự");
    e.code = "invalid_password";
    throw e;
  }
  const passwordHash = bcrypt.hashSync(input.newPassword, bcrypt.genSaltSync(10));
  db.transaction(() => {
    db.run(
      `UPDATE adminUsers SET passwordHash = ?, mustChangePassword = 0, sessionsValidAfter = ?, updatedAt = ? WHERE id = ?`,
      [passwordHash, nowSeconds(), nowIso(), id]
    );
  });
  return true;
}

/**
 * CLI-only "Reset Password to Default" (POST /api/auth/reset-password, local-only
 * per dashboardGuard): clears the Super Admin's password hash so the next login
 * falls back to INITIAL_PASSWORD / "123456" — exactly what the pre-accounts
 * single-password flow did. Not reachable through the account-management API;
 * only this specific CLI action may reset the Super Admin's credentials this way.
 */
export async function resetSuperAdminPasswordToDefault() {
  const db = await getAdapter();
  db.transaction(() => {
    db.run(
      `UPDATE adminUsers SET passwordHash = NULL, mustChangePassword = 0, sessionsValidAfter = ?, updatedAt = ? WHERE role = 'super_admin'`,
      [nowSeconds(), nowIso()]
    );
  });
}

// ── Permission matrix ──────────────────────────────────────────────────────

function rowToPermission(row) {
  return {
    pageKey: row.pageKey,
    view: Number(row.view) === 1,
    edit: Number(row.edit) === 1,
    delete: Number(row.deletePermission) === 1,
  };
}

/** Every permission row for one account, keyed by pageKey. */
export async function getAdminPermissions(adminUserId) {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM adminPermissions WHERE adminUserId = ?`, [adminUserId]);
  const byKey = {};
  for (const row of rows) byKey[row.pageKey] = rowToPermission(row);
  return byKey;
}

/** One page's permission for an account; all-false when no row exists. */
export async function getAdminPermissionForPage(adminUserId, pageKey) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM adminPermissions WHERE adminUserId = ? AND pageKey = ?`, [adminUserId, pageKey]);
  return row ? rowToPermission(row) : { pageKey, view: false, edit: false, delete: false };
}

/**
 * Replace an account's whole matrix in one transaction. `matrix` is
 * `{ [pageKey]: { view, edit, delete } }`; edit/delete without view is invalid
 * input and rejected without writing anything (spec "Every admin dashboard
 * page... edit or delete without view SHALL be rejected").
 */
export function setAdminPermissionsSync(db, adminUserId, matrix = {}) {
  const account = db.get(`SELECT role FROM adminUsers WHERE id = ?`, [adminUserId]);
  if (!account) {
    const e = new Error("Không tìm thấy tài khoản");
    e.code = "not_found";
    throw e;
  }
  if (account.role === "super_admin") {
    const e = new Error("Không thể chỉnh sửa quyền của Super Admin");
    e.code = "super_admin_protected";
    throw e;
  }

  const entries = Object.entries(matrix || {});
  for (const [pageKey, perm] of entries) {
    if (!isValidPageKey(pageKey)) {
      const e = new Error(`Trang không hợp lệ: ${pageKey}`);
      e.code = "invalid_page_key";
      throw e;
    }
    const view = !!perm?.view;
    const edit = !!perm?.edit;
    const del = !!perm?.delete;
    if ((edit || del) && !view) {
      const e = new Error(`${pageKey}: cần bật "Xem" trước khi bật "Sửa" hoặc "Xoá"`);
      e.code = "edit_without_view";
      throw e;
    }
  }

  db.run(`DELETE FROM adminPermissions WHERE adminUserId = ?`, [adminUserId]);
  for (const [pageKey, perm] of entries) {
    db.run(
      `INSERT INTO adminPermissions(adminUserId, pageKey, view, edit, deletePermission) VALUES(?, ?, ?, ?, ?)`,
      [adminUserId, pageKey, perm?.view ? 1 : 0, perm?.edit ? 1 : 0, perm?.delete ? 1 : 0]
    );
  }
}

export async function setAdminPermissions(adminUserId, matrix) {
  const db = await getAdapter();
  db.transaction(() => {
    setAdminPermissionsSync(db, adminUserId, matrix);
  });
  return getAdminPermissions(adminUserId);
}
