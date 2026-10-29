// Customer audit trail: who changed what, when, and why.
//
// Every admin action on an account writes exactly one row here through
// insertAuditSync. Rows are append-only: nothing in the app updates or deletes
// them except the account-deletion cascade, which removes a deleted user's log
// rows along with the rest of their data (the deletion itself is recorded
// afterwards, so it survives).
//
// SYNCHRONOUS + DRIVER-FREE (design D8): callers pass the adapter so this can run
// inside an existing `db.transaction(fn)` and be imported by the bootstrap path
// in migrate.js without creating an import cycle. Never import ../db/driver.js
// or any repo that does.
import { v4 as uuidv4 } from "uuid";
import { stringifyJson, parseJson } from "../db/helpers/jsonCol.js";

function nowIso() {
  return new Date().toISOString();
}

/**
 * Append one audit entry.
 *
 * @param {object} db adapter
 * @param {{ userId: string, actor: string, action: string, reason?: string|null, details?: object|null, now?: string }} entry
 * @returns {{ id: string, userId: string, actor: string, action: string, reason: string|null, details: object|null, createdAt: string }}
 */
export function insertAuditSync(db, { userId, actor, action, reason = null, details = null, now = null } = {}) {
  if (!db) throw new Error("insertAuditSync requires the db adapter");
  if (!userId) throw new Error("insertAuditSync requires a userId");
  if (!actor) throw new Error("insertAuditSync requires an actor");
  if (!action) throw new Error("insertAuditSync requires an action");

  const entry = {
    id: uuidv4(),
    userId,
    actor: String(actor),
    action: String(action),
    reason: reason == null || String(reason).trim() === "" ? null : String(reason),
    details: details == null ? null : details,
    createdAt: now || nowIso(),
  };

  db.run(
    `INSERT INTO userAuditLog(id, userId, actor, action, reason, details, createdAt) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    [entry.id, entry.userId, entry.actor, entry.action, entry.reason, stringifyJson(entry.details), entry.createdAt]
  );

  return entry;
}

/**
 * One page of a user's audit log, newest first.
 *
 * @returns {{ entries: object[], total: number }}
 */
export function listAuditSync(db, userId, { page = 1, pageSize = 50 } = {}) {
  if (!db) throw new Error("listAuditSync requires the db adapter");
  if (!userId) throw new Error("listAuditSync requires a userId");

  const take = Math.min(Math.max(1, Math.floor(Number(pageSize) || 50)), 200);
  const current = Math.max(1, Math.floor(Number(page) || 1));
  const skip = (current - 1) * take;

  const rows = db.all(
    `SELECT * FROM userAuditLog WHERE userId = ? ORDER BY createdAt DESC, rowid DESC LIMIT ? OFFSET ?`,
    [userId, take, skip]
  );
  const total = Number(db.get(`SELECT COUNT(*) AS c FROM userAuditLog WHERE userId = ?`, [userId])?.c ?? 0);

  return {
    entries: rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      actor: row.actor,
      action: row.action,
      reason: row.reason ?? null,
      details: parseJson(row.details, null),
      createdAt: row.createdAt,
    })),
    total,
  };
}
