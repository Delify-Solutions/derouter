import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { getSettings } from "./settingsRepo.js";
import { insertAuditSync } from "../../billing/audit.js";

// Tenant (customer) data access. Admins are NOT users — the admin dashboard is a
// single-password JWT surface (dashboardSession), these rows are paying customers
// with their own accounts, sessions and API keys.
//
// Tokens (session + email verification) are bearer secrets: the raw value is only
// ever returned once, at creation, and the DB stores sha256 hex of it. Lookups hash
// the presented token first, so a DB leak cannot be replayed as a login.

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const SESSION_TTL = SESSION_TTL_MS;

/** sha256 hex of a session/verification token. */
export function hashToken(token) {
  if (!token || typeof token !== "string") return null;
  return crypto.createHash("sha256").update(token).digest("hex");
}

function generateToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

// Very loose shape check: one @, a dot in the domain, no whitespace. Real
// deliverability is proven by the verification mail, not by a regex.
export function isValidEmailShape(email) {
  const value = normalizeEmail(email);
  if (!value || value.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.passwordHash,
    displayName: row.displayName ?? null,
    groupId: row.groupId ?? null,
    status: row.status,
    overdraftNanoUsd: row.overdraftNanoUsd ?? 0,
    // Operator-only. Customer routes build their `user` payload field by field, so
    // this never reaches the account area; admin routes show and edit it.
    adminNote: row.adminNote ?? null,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
    lastLoginAt: row.lastLoginAt ?? null,
  };
}

/** Strip the password hash before a user object leaves the server. */
export function publicUser(user) {
  if (!user) return null;
  const { passwordHash, ...safe } = user;
  return safe;
}

function rowToSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    createdAt: row.createdAt ?? null,
    expiresAt: row.expiresAt ?? null,
    ip: row.ip ?? null,
    userAgent: row.userAgent ?? null,
    revokedAt: row.revokedAt ?? null,
  };
}

/**
 * Which group a newly registered user belongs to.
 * 1. `settings.defaultUserGroupId`, but only if that group still exists and is active.
 * 2. Otherwise the oldest group (smallest createdAt) — the one seeded first.
 * 3. Otherwise null (ungrouped; keys inherit no group limits).
 */
export async function resolveDefaultGroupId() {
  const db = await getAdapter();

  let configured = "";
  try {
    const settings = await getSettings();
    configured = typeof settings.defaultUserGroupId === "string" ? settings.defaultUserGroupId.trim() : "";
  } catch {
    configured = "";
  }
  if (configured) {
    const row = db.get(`SELECT id FROM keyGroups WHERE id = ? AND isActive = 1`, [configured]);
    if (row) return row.id;
  }

  // Fallback: the oldest ACTIVE group. An inactive group cannot own new accounts
  // — its limits no longer describe anything the admin intends to sell, and the
  // start-up repair would immediately move the new user out of it anyway.
  const oldest = db.get(`SELECT id FROM keyGroups WHERE isActive = 1 ORDER BY createdAt ASC, rowid ASC LIMIT 1`);
  return oldest?.id ?? null;
}

export async function getUserById(id) {
  if (!id) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM users WHERE id = ?`, [id]);
  return publicUser(rowToUser(row));
}

export async function getUserByEmail(email) {
  const value = normalizeEmail(email);
  if (!value) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM users WHERE email = ?`, [value]);
  return publicUser(rowToUser(row));
}

/** Same row including `passwordHash` — only for credential checks. */
export async function getUserByEmailWithPassword(email) {
  const value = normalizeEmail(email);
  if (!value) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM users WHERE email = ?`, [value]);
  return rowToUser(row);
}

export async function listUsers() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM users ORDER BY createdAt ASC, rowid ASC`);
  return rows.map((row) => publicUser(rowToUser(row)));
}

/**
 * Create a customer. `groupId` defaults to resolveDefaultGroupId(); `status`
 * defaults to `unverified` when email verification is switched on.
 */
export async function createUser({ email, passwordHash, displayName = null, groupId, status } = {}) {
  const value = normalizeEmail(email);
  if (!value) throw new Error("email is required");
  if (!passwordHash) throw new Error("passwordHash is required");

  const db = await getAdapter();

  let resolvedGroupId;
  if (groupId === undefined) {
    resolvedGroupId = await resolveDefaultGroupId();
  } else {
    resolvedGroupId = groupId || null;
  }

  let resolvedStatus = status;
  if (resolvedStatus === undefined || resolvedStatus === null) {
    let requireVerification = true;
    try {
      const settings = await getSettings();
      requireVerification = settings.requireEmailVerification !== false;
    } catch {
      requireVerification = true;
    }
    resolvedStatus = requireVerification ? "unverified" : "active";
  }

  const now = new Date().toISOString();
  const user = {
    id: uuidv4(),
    email: value,
    passwordHash,
    displayName: displayName ? String(displayName).trim() || null : null,
    groupId: resolvedGroupId,
    status: resolvedStatus,
    overdraftNanoUsd: 0,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
  };

  db.run(
    `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt, lastLoginAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      user.id, user.email, user.passwordHash, user.displayName, user.groupId,
      user.status, user.overdraftNanoUsd, user.createdAt, user.updatedAt, user.lastLoginAt,
    ]
  );

  return publicUser(user);
}

const UPDATABLE_COLUMNS = new Set([
  "email",
  "passwordHash",
  "displayName",
  "groupId",
  "status",
  "overdraftNanoUsd",
  "lastLoginAt",
]);

export async function updateUser(id, patch = {}) {
  if (!id) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM users WHERE id = ?`, [id]);
  if (!row) return null;

  const assignments = [];
  const values = [];
  for (const [key, rawValue] of Object.entries(patch || {})) {
    if (!UPDATABLE_COLUMNS.has(key)) continue;
    let value = rawValue;
    if (key === "email") {
      value = normalizeEmail(value);
      if (!value) continue;
    }
    if (key === "groupId") value = value || null;
    if (key === "displayName") value = value ? String(value).trim() || null : null;
    assignments.push(`${key} = ?`);
    values.push(value);
  }

  assignments.push(`updatedAt = ?`);
  values.push(new Date().toISOString());
  values.push(id);

  db.run(`UPDATE users SET ${assignments.join(", ")} WHERE id = ?`, values);
  const updated = db.get(`SELECT * FROM users WHERE id = ?`, [id]);
  return publicUser(rowToUser(updated));
}

/**
 * Activate every account still waiting for email verification.
 *
 * Verification is decided once, at signup. When the operator later switches the
 * requirement off, accounts created while it was on would otherwise stay
 * `unverified` and keep being refused at login and on their keys.
 *
 * @returns {Promise<number>} how many accounts were activated
 */
export async function activateUnverifiedUsers() {
  const db = await getAdapter();
  const count = Number(db.get(`SELECT COUNT(*) AS n FROM users WHERE status = 'unverified'`)?.n ?? 0);
  if (count === 0) return 0;
  db.run(`UPDATE users SET status = 'active', updatedAt = ? WHERE status = 'unverified'`, [new Date().toISOString()]);
  return count;
}

/**
 * Delete a customer and everything that belongs to them, in ONE transaction.
 *
 * Removed: API keys (a key row outliving its owner would still authenticate),
 * sessions, pending verification tokens, purchased plans, window state, ledger
 * rows, gift redemptions, audit entries, and the user row.
 *
 * KEPT: `orders`. They are the accounting record of money received, and they carry
 * `emailSnapshot` so the buyer stays identifiable after the account is gone.
 *
 * The deletion itself is then recorded as a `user_deleted` audit entry — written
 * AFTER the audit wipe on purpose, because this is the one audit row about a user
 * that must survive their deletion. It keeps the email in `details` for the same
 * reason.
 *
 * @param {string} id
 * @param {{ actor?: string }} options `actor` is an audit actor ("admin:<identity>")
 * @returns {Promise<{deleted: boolean, email: string|null, keyCount: number}>}
 */
export async function deleteUser(id, { actor = "system" } = {}) {
  if (!id) return { deleted: false, email: null, keyCount: 0 };
  const db = await getAdapter();

  let result = { deleted: false, email: null, keyCount: 0 };
  db.transaction(() => {
    const row = db.get(`SELECT id, email FROM users WHERE id = ?`, [id]);
    if (!row) return;
    const email = row.email ?? null;
    const keyCount = Number(db.get(`SELECT COUNT(*) AS n FROM apiKeys WHERE userId = ?`, [id])?.n ?? 0);

    db.run(`DELETE FROM apiKeys WHERE userId = ?`, [id]);
    db.run(`DELETE FROM userSessions WHERE userId = ?`, [id]);
    db.run(`DELETE FROM emailVerifications WHERE userId = ?`, [id]);
    // Window state is keyed by userPlanId; without a foreign key the cascade has
    // to be explicit. The table only exists from GĐ1 on, so a database upgraded
    // mid-release must not fail the deletion over it.
    try {
      db.run(
        `DELETE FROM userPlanWindows WHERE userPlanId IN (SELECT id FROM userPlans WHERE userId = ?)`,
        [id]
      );
    } catch { /* GĐ0 schema has no userPlanWindows yet */ }
    db.run(`DELETE FROM userPlans WHERE userId = ?`, [id]);
    db.run(`DELETE FROM creditLedger WHERE userId = ?`, [id]);
    db.run(`DELETE FROM giftRedemptions WHERE userId = ?`, [id]);
    db.run(`DELETE FROM userAuditLog WHERE userId = ?`, [id]);
    db.run(`DELETE FROM users WHERE id = ?`, [id]);

    insertAuditSync(db, {
      userId: id,
      actor,
      action: "user_deleted",
      details: { userId: id, email },
      now: new Date().toISOString(),
    });

    result = { deleted: true, email, keyCount };
  });
  return result;
}

/**
 * Persist a session row. `token` is the raw bearer value (the user JWT when the
 * caller signs one itself); when omitted a fresh random token is generated and
 * returned. Returns `{ token, session }`.
 */
export async function createSession({ userId, ip = null, userAgent = null, ttlMs = SESSION_TTL_MS, token } = {}) {
  if (!userId) throw new Error("userId is required");
  const db = await getAdapter();
  const rawToken = token || generateToken();
  const now = Date.now();
  const session = {
    id: uuidv4(),
    userId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    ip: ip || null,
    userAgent: userAgent || null,
    revokedAt: null,
  };

  db.run(
    `INSERT INTO userSessions(id, userId, tokenHash, createdAt, expiresAt, ip, userAgent, revokedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      session.id, session.userId, hashToken(rawToken), session.createdAt,
      session.expiresAt, session.ip, session.userAgent, null,
    ]
  );

  return { token: rawToken, session };
}

/**
 * Resolve a live session from its raw token. Returns `{ ...session, user }` or
 * null when the row is missing, revoked, expired, or the user is gone.
 */
export async function getSessionByToken(token) {
  if (!token) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM userSessions WHERE tokenHash = ?`, [hashToken(token)]);
  if (!row) return null;
  if (row.revokedAt) return null;
  const expiresAt = row.expiresAt ? Date.parse(row.expiresAt) : 0;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;

  const userRow = db.get(`SELECT * FROM users WHERE id = ?`, [row.userId]);
  if (!userRow) return null;

  return { ...rowToSession(row), user: publicUser(rowToUser(userRow)) };
}

export async function revokeSession(token) {
  if (!token) return false;
  const db = await getAdapter();
  const res = db.run(
    `UPDATE userSessions SET revokedAt = ? WHERE tokenHash = ? AND revokedAt IS NULL`,
    [new Date().toISOString(), hashToken(token)]
  );
  return (res?.changes ?? 0) > 0;
}

export async function revokeAllUserSessions(userId) {
  if (!userId) return 0;
  const db = await getAdapter();
  const res = db.run(
    `UPDATE userSessions SET revokedAt = ? WHERE userId = ? AND revokedAt IS NULL`,
    [new Date().toISOString(), userId]
  );
  return res?.changes ?? 0;
}

/** Revoke every session of `userId` except the one holding `keepToken`. */
export async function revokeOtherUserSessions(userId, keepToken) {
  if (!userId) return 0;
  const db = await getAdapter();
  const keepHash = hashToken(keepToken);
  const now = new Date().toISOString();
  const res = keepHash
    ? db.run(
        `UPDATE userSessions SET revokedAt = ? WHERE userId = ? AND revokedAt IS NULL AND tokenHash != ?`,
        [now, userId, keepHash]
      )
    : db.run(
        `UPDATE userSessions SET revokedAt = ? WHERE userId = ? AND revokedAt IS NULL`,
        [now, userId]
      );
  return res?.changes ?? 0;
}

export async function touchLastLogin(userId) {
  if (!userId) return;
  const db = await getAdapter();
  const now = new Date().toISOString();
  db.run(`UPDATE users SET lastLoginAt = ?, updatedAt = ? WHERE id = ?`, [now, now, userId]);
}

// ── Email verifications (also used as single-use action tokens) ──────────────

/**
 * Issue a single-use token for `purpose` ("verify_email" | "reset_password").
 * Returns `{ token, id, expiresAt }`; the raw token is never persisted.
 */
export async function createVerification({ userId, purpose, ttlMs = 24 * 60 * 60 * 1000 } = {}) {
  if (!userId) throw new Error("userId is required");
  if (!purpose) throw new Error("purpose is required");
  const db = await getAdapter();
  const token = generateToken();
  const now = new Date();
  const row = {
    id: uuidv4(),
    userId,
    tokenHash: hashToken(token),
    purpose,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    consumedAt: null,
    createdAt: now.toISOString(),
  };
  db.run(
    `INSERT INTO emailVerifications(id, userId, tokenHash, purpose, expiresAt, consumedAt, createdAt) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.userId, row.tokenHash, row.purpose, row.expiresAt, null, row.createdAt]
  );
  return { token, id: row.id, userId, purpose, expiresAt: row.expiresAt };
}

/**
 * Mark the token consumed and return its userId, or null when it is unknown,
 * of another purpose, already consumed, or expired.
 */
export async function consumeVerification(token, purpose) {
  if (!token) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM emailVerifications WHERE tokenHash = ?`, [hashToken(token)]);
  if (!row) return null;
  if (purpose && row.purpose !== purpose) return null;
  if (row.consumedAt) return null;
  const expiresAt = row.expiresAt ? Date.parse(row.expiresAt) : 0;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;

  const res = db.run(
    `UPDATE emailVerifications SET consumedAt = ? WHERE id = ? AND consumedAt IS NULL`,
    [new Date().toISOString(), row.id]
  );
  // Lost a race with a concurrent consumer: no second use.
  if ((res?.changes ?? 0) === 0) return null;
  return row.userId;
}

/** Read a verification row by raw token (no side effects) — for idempotent flows. */
export async function getVerificationByToken(token) {
  if (!token) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM emailVerifications WHERE tokenHash = ?`, [hashToken(token)]);
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    purpose: row.purpose,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt ?? null,
    createdAt: row.createdAt,
  };
}

/** Drop the oldest outstanding tokens for a user+purpose and issue a new one. */
export async function replaceVerification({ userId, purpose, ttlMs } = {}) {
  if (!userId) throw new Error("userId is required");
  if (!purpose) throw new Error("purpose is required");
  const db = await getAdapter();
  db.run(
    `DELETE FROM emailVerifications WHERE userId = ? AND purpose = ? AND consumedAt IS NULL`,
    [userId, purpose]
  );
  return createVerification({ userId, purpose, ttlMs });
}

// ── Session administration (admin user detail page) ──────────────────────────

/**
 * Every open session of a user, newest first — creation, expiry, IP and user agent
 * (spec admin-user-management, `Phiên đăng nhập` tab).
 */
export async function listUserSessions(userId) {
  if (!userId) return [];
  const db = await getAdapter();
  const rows = db.all(
    `SELECT id, userId, createdAt, expiresAt, ip, userAgent, revokedAt
       FROM userSessions
      WHERE userId = ? AND revokedAt IS NULL AND expiresAt > ?
      ORDER BY createdAt DESC`,
    [userId, new Date().toISOString()]
  );
  return rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    createdAt: row.createdAt ?? null,
    expiresAt: row.expiresAt ?? null,
    ip: row.ip ?? null,
    userAgent: row.userAgent ?? null,
  }));
}

/**
 * Revoke one session by id, scoped to its owner. Returns whether a live session was
 * actually revoked — a session that already expired must not report success.
 */
export async function revokeSessionById(userId, sessionId) {
  if (!userId || !sessionId) return false;
  const db = await getAdapter();
  const res = db.run(
    `UPDATE userSessions SET revokedAt = ? WHERE id = ? AND userId = ? AND revokedAt IS NULL`,
    [new Date().toISOString(), sessionId, userId]
  );
  return (res?.changes ?? 0) > 0;
}

// Gift redemptions already have a richer reader in giftRepo.listUserRedemptions
// (it joins the granted purchase and formats the code); the admin `Mã quà tặng` tab
// uses that one instead of a second implementation here.

