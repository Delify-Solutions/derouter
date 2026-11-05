// Self-service email change (change account-settings, design D1).
//
// The address changes only when the single-use link mailed to the NEW address is
// opened. The token row carries the new address (`emailVerifications.newEmail`);
// the raw token is never stored or logged. Every function here is synchronous and
// takes the adapter first, so the confirm step runs in one transaction.
import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { hashToken, normalizeEmail, isValidEmailShape } from "../db/repos/userRepo.js";

export const EMAIL_CHANGE_PURPOSE = "change_email";
export const EMAIL_CHANGE_TTL_MS = 24 * 60 * 60 * 1000;

/** A refusal the route turns into a Vietnamese message and a status. */
export class EmailChangeError extends Error {
  constructor(reason, message, status = 400) {
    super(message);
    this.reason = reason;
    this.status = status;
  }
}

/**
 * Check the requested address against the account and the other accounts.
 * The password is checked by the caller (bcrypt is async). Returns the
 * normalised address or throws EmailChangeError.
 */
export function validateNewEmailSync(db, userId, rawEmail) {
  const newEmail = normalizeEmail(rawEmail);
  if (!isValidEmailShape(newEmail)) {
    throw new EmailChangeError("bad_email", "Email mới không hợp lệ");
  }
  const me = db.get(`SELECT email FROM users WHERE id = ?`, [userId]);
  if (!me) throw new EmailChangeError("no_user", "Không tìm thấy tài khoản", 401);
  if (normalizeEmail(me.email) === newEmail) {
    throw new EmailChangeError("same_email", "Email mới trùng email hiện tại");
  }
  const taken = db.get(`SELECT id FROM users WHERE email = ? AND id != ?`, [newEmail, userId]);
  if (taken) throw new EmailChangeError("taken", "Email này đã được dùng cho một tài khoản khác", 409);
  return newEmail;
}

/**
 * Issue the confirmation token for `newEmail`, dropping any earlier pending
 * change of this account so only the latest link works.
 * @returns {{ token: string, id: string, newEmail: string, expiresAt: string }}
 */
export function createEmailChangeSync(db, userId, newEmail, { now = Date.now() } = {}) {
  db.run(
    `DELETE FROM emailVerifications WHERE userId = ? AND purpose = ? AND consumedAt IS NULL`,
    [userId, EMAIL_CHANGE_PURPOSE]
  );
  const token = crypto.randomBytes(32).toString("base64url");
  const id = uuidv4();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + EMAIL_CHANGE_TTL_MS).toISOString();
  db.run(
    `INSERT INTO emailVerifications(id, userId, tokenHash, purpose, newEmail, expiresAt, consumedAt, createdAt)
     VALUES(?, ?, ?, ?, ?, ?, NULL, ?)`,
    [id, userId, hashToken(token), EMAIL_CHANGE_PURPOSE, newEmail, expiresAt, createdAt]
  );
  return { token, id, newEmail, expiresAt };
}

/** Remove one issued token (the mail could not be sent: nothing may stay pending). */
export function dropEmailChangeSync(db, id) {
  db.run(`DELETE FROM emailVerifications WHERE id = ? AND consumedAt IS NULL`, [id]);
}

/** The account's pending change `{ newEmail, expiresAt }`, or null. */
export function pendingEmailChangeSync(db, userId, { now = Date.now() } = {}) {
  const row = db.get(
    `SELECT newEmail, expiresAt FROM emailVerifications
      WHERE userId = ? AND purpose = ? AND consumedAt IS NULL AND expiresAt > ?
      ORDER BY createdAt DESC LIMIT 1`,
    [userId, EMAIL_CHANGE_PURPOSE, new Date(now).toISOString()]
  );
  return row ? { newEmail: row.newEmail, expiresAt: row.expiresAt } : null;
}

/** Cancel every pending change of the account. Returns how many were cancelled. */
export function cancelEmailChangeSync(db, userId) {
  const res = db.run(
    `DELETE FROM emailVerifications WHERE userId = ? AND purpose = ? AND consumedAt IS NULL`,
    [userId, EMAIL_CHANGE_PURPOSE]
  );
  return Number(res?.changes ?? 0);
}

function isUniqueViolation(error) {
  return /UNIQUE constraint failed/i.test(String(error?.message || "")) || error?.code === "SQLITE_CONSTRAINT_UNIQUE";
}

/**
 * Apply the change the link stands for. Run inside `db.transaction`.
 *
 * @returns {{ ok: true, userId, oldEmail, newEmail, activated: boolean }
 *          | { ok: false, reason: "invalid" | "taken" | "no_user" }}
 */
export function confirmEmailChangeSync(db, token, { now = Date.now() } = {}) {
  const hash = hashToken(token);
  if (!hash) return { ok: false, reason: "invalid" };
  const row = db.get(`SELECT * FROM emailVerifications WHERE tokenHash = ?`, [hash]);
  if (!row || row.purpose !== EMAIL_CHANGE_PURPOSE || row.consumedAt || !row.newEmail) {
    return { ok: false, reason: "invalid" };
  }
  const expires = Date.parse(row.expiresAt || "");
  if (!Number.isFinite(expires) || expires <= now) return { ok: false, reason: "invalid" };

  const user = db.get(`SELECT id, email, status FROM users WHERE id = ?`, [row.userId]);
  if (!user) return { ok: false, reason: "no_user" };

  const newEmail = normalizeEmail(row.newEmail);
  // Another account may have taken the address since the request.
  if (db.get(`SELECT id FROM users WHERE email = ? AND id != ?`, [newEmail, user.id])) {
    return { ok: false, reason: "taken" };
  }

  const at = new Date(now).toISOString();
  // Opening the link proves the mailbox, the same rule as verify-email: an
  // unverified account becomes active; a suspended one is never reactivated here.
  const activated = user.status === "unverified";
  try {
    db.run(
      `UPDATE users SET email = ?, status = ?, updatedAt = ? WHERE id = ?`,
      [newEmail, activated ? "active" : user.status, at, user.id]
    );
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, reason: "taken" };
    throw error;
  }
  db.run(`UPDATE emailVerifications SET consumedAt = ? WHERE id = ?`, [at, row.id]);
  // Every other outstanding token of this account was mailed to an address it
  // no longer uses (or is moot): a password-reset link sitting in the OLD
  // mailbox must not be able to take the account back after the move.
  db.run(`DELETE FROM emailVerifications WHERE userId = ? AND consumedAt IS NULL`, [user.id]);
  return { ok: true, userId: user.id, oldEmail: user.email, newEmail, activated };
}
