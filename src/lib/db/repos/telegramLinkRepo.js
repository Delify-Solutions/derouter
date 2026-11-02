// Linking customer accounts to Telegram users (spec telegram-link).
//
// The web page asks for a one-time token; the Mini App launched with that token
// proves (through Telegram's signature, see src/lib/telegram/initData.js) which
// Telegram user opened it. consumeLinkTokenSync joins the two. Only the SHA-256
// of a token is stored, so a database read never yields a usable link.
//
// Synchronous, db-first: callers run these inside db.transaction().

import crypto from "node:crypto";

export const LINK_TOKEN_TTL_MS = 10 * 60 * 1000;

export const LINK_ERROR_TEXT = {
  invalid_token: "Link đã hết hạn hoặc đã dùng, hãy tạo link mới trên trang web",
  telegram_taken: "Tài khoản Telegram này đang liên kết với tài khoản khác",
  user_not_found: "Không tìm thấy tài khoản",
};

export function hashLinkToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

/**
 * Issue a token for `userId`. Earlier unused tokens of the account are dropped,
 * so only the newest link works. Returns `{ token, expiresAt }`.
 */
export function issueLinkTokenSync(db, userId, { now = Date.now() } = {}) {
  if (!userId) throw new Error("userId is required");
  // 32 random bytes in base64url: within the [A-Za-z0-9_-] alphabet and 64-char
  // limit Telegram allows for startapp.
  const token = crypto.randomBytes(32).toString("base64url");
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + LINK_TOKEN_TTL_MS).toISOString();
  db.run(`DELETE FROM telegramLinkTokens WHERE userId = ? AND usedAt IS NULL`, [userId]);
  // Housekeeping: tokens past expiry are useless to everyone.
  db.run(`DELETE FROM telegramLinkTokens WHERE expiresAt < ?`, [new Date(now - LINK_TOKEN_TTL_MS).toISOString()]);
  db.run(
    `INSERT INTO telegramLinkTokens(tokenHash, userId, createdAt, expiresAt, usedAt) VALUES(?, ?, ?, ?, NULL)`,
    [hashLinkToken(token), userId, createdAt, expiresAt]
  );
  return { token, expiresAt };
}

/**
 * Link the account a token was issued for to a Telegram user and burn the token.
 *
 * @returns {{ ok: true, userId: string, email: string }
 *          | { ok: false, reason: "invalid_token"|"telegram_taken"|"user_not_found" }}
 */
export function consumeLinkTokenSync(db, token, telegramUser, { now = Date.now() } = {}) {
  if (!token || !telegramUser?.id) return { ok: false, reason: "invalid_token" };
  const nowIso = new Date(now).toISOString();
  const row = db.get(`SELECT * FROM telegramLinkTokens WHERE tokenHash = ?`, [hashLinkToken(token)]);
  if (!row || row.usedAt || row.expiresAt < nowIso) return { ok: false, reason: "invalid_token" };

  const user = db.get(`SELECT id, email FROM users WHERE id = ?`, [row.userId]);
  if (!user) return { ok: false, reason: "user_not_found" };

  const telegramUserId = String(telegramUser.id);
  const holder = db.get(`SELECT id FROM users WHERE telegramUserId = ?`, [telegramUserId]);
  if (holder && holder.id !== user.id) return { ok: false, reason: "telegram_taken" };

  db.run(
    // A fresh link clears the "Telegram refuses delivery" marker of any earlier one.
    `UPDATE users SET telegramUserId = ?, telegramUsername = ?, telegramLinkedAt = ?, telegramDmBlockedAt = NULL, updatedAt = ?
      WHERE id = ?`,
    [telegramUserId, telegramUser.username ?? null, nowIso, nowIso, user.id]
  );
  db.run(`UPDATE telegramLinkTokens SET usedAt = ? WHERE tokenHash = ?`, [nowIso, row.tokenHash]);
  return { ok: true, userId: user.id, email: user.email };
}

/**
 * `{ linked, telegramUserId, telegramUsername, linkedAt, notifyPrefs, dmBlockedAt }`
 * for one account. notifyPrefs is the raw JSON text (see src/lib/notify/customerTelegram.js).
 */
export function getTelegramLinkSync(db, userId) {
  const row = db.get(
    `SELECT telegramUserId, telegramUsername, telegramLinkedAt, telegramNotifyPrefs, telegramDmBlockedAt
       FROM users WHERE id = ?`,
    [userId]
  );
  return {
    linked: Boolean(row?.telegramUserId),
    telegramUserId: row?.telegramUserId ?? null,
    telegramUsername: row?.telegramUsername ?? null,
    linkedAt: row?.telegramLinkedAt ?? null,
    notifyPrefs: row?.telegramNotifyPrefs ?? null,
    dmBlockedAt: row?.telegramDmBlockedAt ?? null,
  };
}

/** Store the customer's notification groups (JSON object of booleans). */
export function setTelegramNotifyPrefsSync(db, userId, prefs) {
  db.run(`UPDATE users SET telegramNotifyPrefs = ?, updatedAt = ? WHERE id = ?`, [
    JSON.stringify(prefs),
    new Date().toISOString(),
    userId,
  ]);
}

/** Clear the account's link. Past gift redemptions keep their Telegram snapshot. */
export function unlinkTelegramSync(db, userId) {
  const nowIso = new Date().toISOString();
  const res = db.run(
    `UPDATE users SET telegramUserId = NULL, telegramUsername = NULL, telegramLinkedAt = NULL, telegramDmBlockedAt = NULL, updatedAt = ?
      WHERE id = ? AND telegramUserId IS NOT NULL`,
    [nowIso, userId]
  );
  db.run(`DELETE FROM telegramLinkTokens WHERE userId = ? AND usedAt IS NULL`, [userId]);
  return (res?.changes ?? 0) > 0;
}

/** "a***@gmail.com": enough for the customer to recognise the account, not to read it. */
export function maskEmail(email) {
  const value = String(email || "");
  const at = value.indexOf("@");
  if (at <= 0) return "***";
  return `${value[0]}***${value.slice(at)}`;
}
