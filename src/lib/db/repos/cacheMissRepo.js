// Data access for `cacheMissDetections` (change cache-miss-auto-refund, capability
// cache-miss-refund). SYNCHRONOUS functions take the adapter first and end in
// `Sync` — callers run them inside an existing `db.transaction`, same convention
// as billingRepo.js / planQueue.js.
//
// No internal cause (connectionId, rotation wording) is ever read back out through
// the async list/stat helpers below in a form meant for display — only neutral
// facts (timestamps, tokens, provider, model). See spec cache-miss-refund
// "Admin review page — No internal cause exposed".
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

function nowIso() {
  return new Date().toISOString();
}

/**
 * Record one flagged request. Idempotent: `usageHistoryId` is UNIQUE, so a
 * duplicate call for the same request (should never happen — the caller only
 * reaches this once, right after inserting that usageHistory row — but a retry
 * or a future bug must never produce a second row) is swallowed rather than
 * thrown, matching the fail-open convention the rest of usage logging uses.
 *
 * SYNCHRONOUS — must run inside the caller's db.transaction, right after the
 * usageHistory row it references was inserted.
 */
export function insertCacheMissDetectionSync(db, {
  usageHistoryId,
  userId,
  apiKeyId = null,
  provider,
  model,
  requestedModel = null,
  overlapTokens,
  refundNanoUsd,
  detectedAt = null,
} = {}) {
  if (!db) throw new Error("insertCacheMissDetectionSync requires the db adapter");
  if (!usageHistoryId || !userId) return null;
  const id = uuidv4();
  try {
    db.run(
      `INSERT INTO cacheMissDetections(id, usageHistoryId, userId, apiKeyId, provider, model, requestedModel, overlapTokens, refundNanoUsd, status, detectedAt)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [
        id,
        Math.round(Number(usageHistoryId)),
        userId,
        apiKeyId,
        provider || "unknown",
        model || "unknown",
        requestedModel || null,
        Math.max(0, Math.round(Number(overlapTokens) || 0)),
        Math.max(0, Math.round(Number(refundNanoUsd) || 0)),
        detectedAt || nowIso(),
      ]
    );
    return id;
  } catch (e) {
    // UNIQUE(usageHistoryId) violation = already recorded; anything else is logged
    // and swallowed — a detection must never break the usage write it rides along.
    console.error("[cacheMissRepo] insert failed (swallowed):", e?.message || e);
    return null;
  }
}

function rowToDetection(row) {
  return {
    id: row.id,
    usageHistoryId: row.usageHistoryId,
    userId: row.userId,
    apiKeyId: row.apiKeyId ?? null,
    provider: row.provider,
    model: row.model,
    requestedModel: row.requestedModel ?? null,
    overlapTokens: Number(row.overlapTokens) || 0,
    refundNanoUsd: Number(row.refundNanoUsd) || 0,
    status: row.status,
    ledgerId: row.ledgerId ?? null,
    detectedAt: row.detectedAt,
    resolvedAt: row.resolvedAt ?? null,
    adminNote: row.adminNote ?? null,
  };
}

/** Every pending detection, oldest first — the daily sweep's own query. SYNCHRONOUS. */
export function listPendingDetectionsSync(db) {
  const rows = db.all(
    `SELECT * FROM cacheMissDetections WHERE status = 'pending' ORDER BY detectedAt ASC, id ASC`
  );
  return rows.map(rowToDetection);
}

/** One detection by id. SYNCHRONOUS. */
export function getDetectionByIdSync(db, id) {
  const row = db.get(`SELECT * FROM cacheMissDetections WHERE id = ?`, [id]);
  return row ? rowToDetection(row) : null;
}

/**
 * Mark a detection refunded (auto or admin-approved). SYNCHRONOUS — run inside the
 * same transaction that inserted the `creditLedger` row, so the two can never
 * disagree about whether the money moved.
 */
export function markDetectionRefundedSync(db, id, { status, ledgerId, resolvedAt = null } = {}) {
  db.run(
    `UPDATE cacheMissDetections SET status = ?, ledgerId = ?, resolvedAt = ? WHERE id = ?`,
    [status, ledgerId, resolvedAt || nowIso(), id]
  );
}

/** Reject a pending detection. Permanent — never revisited by the sweep. SYNCHRONOUS. */
export function rejectDetectionSync(db, id, { adminNote = null, resolvedAt = null } = {}) {
  db.run(
    `UPDATE cacheMissDetections SET status = 'rejected', resolvedAt = ?, adminNote = ? WHERE id = ? AND status = 'pending'`,
    [resolvedAt || nowIso(), adminNote, id]
  );
}

// ── Admin / customer reads (async, resolve their own adapter) ───────────────

/**
 * Every detection (admin review page), optionally filtered by user. Neutral facts
 * only — no field here names a connection/account or rotation (spec cache-miss-refund
 * "No internal cause exposed").
 */
export async function listCacheMissDetections({ userId = null, limit = 500 } = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];
  if (userId) { conds.push("cmd.userId = ?"); params.push(userId); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const take = Math.min(Math.max(1, Math.floor(Number(limit) || 500)), 5000);
  const rows = db.all(
    `SELECT cmd.*, u.email AS userEmail
       FROM cacheMissDetections cmd
       LEFT JOIN users u ON u.id = cmd.userId
      ${where}
      ORDER BY cmd.detectedAt DESC
      LIMIT ?`,
    [...params, take]
  );
  return rows.map((row) => ({ ...rowToDetection(row), userEmail: row.userEmail || null }));
}

/** Aggregate stats for the admin page's chosen period (and optional user filter). */
export async function getCacheMissStats({ userId = null, sinceIso = null } = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];
  if (userId) { conds.push("userId = ?"); params.push(userId); }
  if (sinceIso) { conds.push("detectedAt >= ?"); params.push(sinceIso); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const row = db.get(
    `SELECT COUNT(*) AS detected,
            COALESCE(SUM(CASE WHEN status IN ('auto_refunded', 'approved') THEN refundNanoUsd ELSE 0 END), 0) AS refundedNanoUsd,
            COALESCE(SUM(CASE WHEN status = 'pending' THEN refundNanoUsd ELSE 0 END), 0) AS pendingNanoUsd
       FROM cacheMissDetections ${where}`,
    params
  );
  return {
    detected: Number(row?.detected) || 0,
    refundedNanoUsd: Number(row?.refundedNanoUsd) || 0,
    pendingNanoUsd: Number(row?.pendingNanoUsd) || 0,
  };
}

/** A customer's own refunded detections (auto or admin-approved), newest first. */
export async function listCustomerCacheMissRefunds(userId, { limit = 200 } = {}) {
  if (!userId) return [];
  const db = await getAdapter();
  const take = Math.min(Math.max(1, Math.floor(Number(limit) || 200)), 1000);
  const rows = db.all(
    `SELECT * FROM cacheMissDetections
      WHERE userId = ? AND status IN ('auto_refunded', 'approved')
      ORDER BY resolvedAt DESC, detectedAt DESC
      LIMIT ?`,
    [userId, take]
  );
  return rows.map(rowToDetection);
}

/** Every usageHistoryId of a user's flagged requests, for the /account/usage indicator. */
export async function listFlaggedUsageHistoryIds(userId) {
  if (!userId) return new Set();
  const db = await getAdapter();
  const rows = db.all(`SELECT usageHistoryId FROM cacheMissDetections WHERE userId = ?`, [userId]);
  return new Set(rows.map((r) => Number(r.usageHistoryId)));
}
