// Web inbox: announcements for everyone and the customer's own notifications
// (change models-notifications D3–D5). Synchronous, adapter first, relative
// imports only.
import crypto from "node:crypto";

export const ANNOUNCEMENT_TITLE_MAX = 120;
export const ANNOUNCEMENT_BODY_MAX = 2000;
export const INBOX_KINDS = ["billing", "expiry", "security"];
const INBOX_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

/** Telegram HTML → plain text: tags stripped, the five escapes decoded. */
export function plainText(html) {
  return String(html ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m);
}

/**
 * Store one personal notification from the text notifyCustomer builds:
 * first line = title (the "<site> · " prefix dropped), the rest = body.
 * Announcements (broadcasts) are never stored here.
 */
export function recordInboxSync(db, userId, kind, builtText, { now = new Date().toISOString(), siteName = null } = {}) {
  if (!userId || !INBOX_KINDS.includes(kind)) return false;
  const text = plainText(builtText).trim();
  if (!text) return false;
  const [first, ...rest] = text.split("\n");
  // Messages are headed "<site> · <title>": drop exactly that prefix, so a "·"
  // inside the site name or the title never cuts the title.
  const prefix = siteName ? `${siteName} · ` : null;
  const title = (prefix && first.startsWith(prefix) ? first.slice(prefix.length) : first.replace(/^[^·]*·\s*/, "")).trim() || first.trim();
  const body = rest.join("\n").trim() || null;
  db.run(
    `INSERT INTO customerNotifications(userId, kind, title, body, createdAt) VALUES(?, ?, ?, ?, ?)`,
    [userId, kind, title.slice(0, 200), body ? body.slice(0, 4000) : null, now]
  );
  return true;
}

/** Validate an announcement draft. @returns {{ value } | { error }} */
export function validateAnnouncement(input = {}) {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!title) return { error: "Nhập tiêu đề" };
  if (title.length > ANNOUNCEMENT_TITLE_MAX) return { error: `Tiêu đề tối đa ${ANNOUNCEMENT_TITLE_MAX} ký tự` };
  if (!body) return { error: "Nhập nội dung" };
  if (body.length > ANNOUNCEMENT_BODY_MAX) return { error: `Nội dung tối đa ${ANNOUNCEMENT_BODY_MAX} ký tự` };
  return { value: { title, body, important: input.important === true } };
}

function toAnnouncement(row) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    important: Number(row.important) === 1,
    telegramBroadcastId: row.telegramBroadcastId ?? null,
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createAnnouncementSync(db, value, { createdBy = null, now = new Date().toISOString() } = {}) {
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO announcements(id, title, body, important, createdBy, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    [id, value.title, value.body, value.important ? 1 : 0, createdBy, now, now]
  );
  return toAnnouncement(db.get(`SELECT * FROM announcements WHERE id = ?`, [id]));
}

export function updateAnnouncementSync(db, id, value, { now = new Date().toISOString() } = {}) {
  const res = db.run(
    `UPDATE announcements SET title = ?, body = ?, important = ?, updatedAt = ? WHERE id = ?`,
    [value.title, value.body, value.important ? 1 : 0, now, id]
  );
  if ((res?.changes ?? 0) === 0) return null;
  return toAnnouncement(db.get(`SELECT * FROM announcements WHERE id = ?`, [id]));
}

export function setAnnouncementBroadcastSync(db, id, broadcastId) {
  db.run(`UPDATE announcements SET telegramBroadcastId = ? WHERE id = ?`, [broadcastId, id]);
}

export function deleteAnnouncementSync(db, id) {
  const res = db.run(`DELETE FROM announcements WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export function listAnnouncementsSync(db, { limit = 50, offset = 0 } = {}) {
  const take = Math.min(Math.max(1, Math.floor(Number(limit) || 50)), 100);
  const skip = Math.max(0, Math.floor(Number(offset) || 0));
  const rows = db.all(`SELECT * FROM announcements ORDER BY createdAt DESC, rowid DESC LIMIT ? OFFSET ?`, [take, skip]);
  const total = Number(db.get(`SELECT COUNT(*) AS n FROM announcements`)?.n ?? 0);
  return { rows: rows.map(toAnnouncement), total };
}

function seenAtSync(db, userId) {
  const row = db.get(`SELECT notificationsSeenAt, createdAt FROM users WHERE id = ?`, [userId]);
  return row?.notificationsSeenAt || row?.createdAt || "1970-01-01T00:00:00.000Z";
}

/** The customer's inbox: announcements, own notifications (last 180 days), unread count. */
export function customerInboxSync(db, userId, { now = Date.now(), limit = 50 } = {}) {
  const take = Math.min(Math.max(1, Math.floor(Number(limit) || 50)), 100);
  const since = new Date(now - INBOX_DAYS * DAY_MS).toISOString();
  const seenAt = seenAtSync(db, userId);
  const announcements = db
    .all(`SELECT * FROM announcements ORDER BY createdAt DESC, rowid DESC LIMIT ?`, [take])
    .map((row) => ({ ...toAnnouncement(row), unread: row.createdAt > seenAt }));
  const personal = db
    .all(
      `SELECT id, kind, title, body, createdAt FROM customerNotifications
        WHERE userId = ? AND createdAt >= ? ORDER BY createdAt DESC, id DESC LIMIT ?`,
      [userId, since, take]
    )
    .map((row) => ({ ...row, unread: row.createdAt > seenAt }));
  // The instant this view covers: marking read up to it never hides an item
  // created after the page loaded.
  return { announcements, personal, unread: unreadCountSync(db, userId, { now, seenAt }), asOf: new Date(now).toISOString() };
}

export function unreadCountSync(db, userId, { now = Date.now(), seenAt = null } = {}) {
  if (!userId) return 0;
  const after = seenAt || seenAtSync(db, userId);
  const since = new Date(now - INBOX_DAYS * DAY_MS).toISOString();
  const a = Number(db.get(`SELECT COUNT(*) AS n FROM announcements WHERE createdAt > ?`, [after])?.n ?? 0);
  const p = Number(
    db.get(
      `SELECT COUNT(*) AS n FROM customerNotifications WHERE userId = ? AND createdAt > ? AND createdAt >= ?`,
      [userId, after, since]
    )?.n ?? 0
  );
  return a + p;
}

export function markInboxSeenSync(db, userId, { now = new Date().toISOString(), upTo = null } = {}) {
  // Never later than now, never moved backwards.
  const at = upTo && upTo < now ? upTo : now;
  db.run(
    `UPDATE users SET notificationsSeenAt = ? WHERE id = ? AND (notificationsSeenAt IS NULL OR notificationsSeenAt < ?)`,
    [at, userId, at]
  );
}
