// Account activity with client IPs, and the admin IP lookups built on it
// (spec activity-ip-log).
//
// Two sources describe where an account has been: activityLog (web actions) and
// usageHistory.clientIp (API requests made with the account's keys). The lookups
// merge both. Relative imports only: tests import this module directly.

import { getAdapter } from "../driver.js";
import { getRequestIp, getRequestUserAgent } from "../../auth/clientIp.js";

/** API usage older than this is left out of IP lookups to keep the scan bounded. */
export const IP_LOOKBACK_DAYS = 90;

function stringifyDetails(details) {
  if (!details || typeof details !== "object") return null;
  try {
    const text = JSON.stringify(details);
    return text.length > 2000 ? text.slice(0, 2000) : text;
  } catch {
    return null;
  }
}

function parseDetails(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sinceIso(now = Date.now(), days = IP_LOOKBACK_DAYS) {
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
}

export function insertActivitySync(db, { userId = null, action, ip = null, userAgent = null, details = null, createdAt = null }) {
  if (!action) throw new Error("action is required");
  db.run(
    `INSERT INTO activityLog(userId, action, ip, userAgent, details, createdAt) VALUES(?, ?, ?, ?, ?, ?)`,
    [
      userId || null,
      String(action),
      ip || null,
      userAgent ? String(userAgent).slice(0, 300) : null,
      stringifyDetails(details),
      createdAt || new Date().toISOString(),
    ]
  );
}

/**
 * Log an account action with the request's client IP. Never throws and never
 * logs request data: a failed write must not fail the action it describes.
 */
export async function recordActivity(request, { userId = null, action, details = null } = {}) {
  try {
    const db = await getAdapter();
    insertActivitySync(db, {
      userId,
      action,
      ip: getRequestIp(request),
      userAgent: getRequestUserAgent(request),
      details,
    });
  } catch (error) {
    console.error("[activity] write failed:", error?.message || "unknown error");
  }
}

/** Newest-first activity of one account. */
export function listUserActivitySync(db, userId, { limit = 100 } = {}) {
  const rows = db.all(
    `SELECT id, action, ip, userAgent, details, createdAt FROM activityLog
      WHERE userId = ? ORDER BY createdAt DESC, id DESC LIMIT ?`,
    [userId, Math.max(1, Math.min(500, Number(limit) || 100))]
  );
  return rows.map((row) => ({ ...row, details: parseDetails(row.details) }));
}

// Distinct accounts seen on one IP, from either source, within the lookback.
function usersOnIpSync(db, ip, since) {
  const ids = new Set();
  for (const row of db.all(`SELECT DISTINCT userId FROM activityLog WHERE ip = ? AND userId IS NOT NULL`, [ip])) {
    ids.add(row.userId);
  }
  for (const row of db.all(
    `SELECT DISTINCT k.userId AS userId FROM usageHistory u JOIN apiKeys k ON k.id = u.apiKeyId
      WHERE u.clientIp = ? AND u.timestamp >= ? AND k.userId IS NOT NULL`,
    [ip, since]
  )) {
    ids.add(row.userId);
  }
  return ids;
}

function mergeSpan(target, first, last) {
  if (first && (!target.firstSeen || first < target.firstSeen)) target.firstSeen = first;
  if (last && (!target.lastSeen || last > target.lastSeen)) target.lastSeen = last;
}

/**
 * Every IP an account used: web actions plus its keys' API requests (last 90
 * days), with how many OTHER accounts were seen on the same IP. Newest first.
 */
export function listUserIpsSync(db, userId, { now = Date.now() } = {}) {
  const since = sinceIso(now);
  const byIp = new Map();
  const entry = (ip) => {
    if (!byIp.has(ip)) byIp.set(ip, { ip, webCount: 0, apiCount: 0, firstSeen: null, lastSeen: null, otherAccounts: 0 });
    return byIp.get(ip);
  };

  for (const row of db.all(
    `SELECT ip, COUNT(*) AS c, MIN(createdAt) AS firstSeen, MAX(createdAt) AS lastSeen
       FROM activityLog WHERE userId = ? AND ip IS NOT NULL GROUP BY ip`,
    [userId]
  )) {
    const item = entry(row.ip);
    item.webCount += Number(row.c) || 0;
    mergeSpan(item, row.firstSeen, row.lastSeen);
  }
  for (const row of db.all(
    `SELECT u.clientIp AS ip, COUNT(*) AS c, MIN(u.timestamp) AS firstSeen, MAX(u.timestamp) AS lastSeen
       FROM usageHistory u JOIN apiKeys k ON k.id = u.apiKeyId
      WHERE k.userId = ? AND u.clientIp IS NOT NULL AND u.timestamp >= ?
      GROUP BY u.clientIp`,
    [userId, since]
  )) {
    const item = entry(row.ip);
    item.apiCount += Number(row.c) || 0;
    mergeSpan(item, row.firstSeen, row.lastSeen);
  }

  for (const item of byIp.values()) {
    const users = usersOnIpSync(db, item.ip, since);
    users.delete(userId);
    item.otherAccounts = users.size;
  }
  return [...byIp.values()].sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
}

/** Every account seen on one IP, with email, status and counts. Newest first. */
export function listAccountsByIpSync(db, ip, { now = Date.now() } = {}) {
  const since = sinceIso(now);
  const byUser = new Map();
  const entry = (userId) => {
    if (!byUser.has(userId)) byUser.set(userId, { userId, webCount: 0, apiCount: 0, firstSeen: null, lastSeen: null });
    return byUser.get(userId);
  };

  for (const row of db.all(
    `SELECT userId, COUNT(*) AS c, MIN(createdAt) AS firstSeen, MAX(createdAt) AS lastSeen
       FROM activityLog WHERE ip = ? AND userId IS NOT NULL GROUP BY userId`,
    [ip]
  )) {
    const item = entry(row.userId);
    item.webCount += Number(row.c) || 0;
    mergeSpan(item, row.firstSeen, row.lastSeen);
  }
  for (const row of db.all(
    `SELECT k.userId AS userId, COUNT(*) AS c, MIN(u.timestamp) AS firstSeen, MAX(u.timestamp) AS lastSeen
       FROM usageHistory u JOIN apiKeys k ON k.id = u.apiKeyId
      WHERE u.clientIp = ? AND u.timestamp >= ? AND k.userId IS NOT NULL
      GROUP BY k.userId`,
    [ip, since]
  )) {
    const item = entry(row.userId);
    item.apiCount += Number(row.c) || 0;
    mergeSpan(item, row.firstSeen, row.lastSeen);
  }

  const out = [];
  for (const item of byUser.values()) {
    const user = db.get(`SELECT email, status, displayName FROM users WHERE id = ?`, [item.userId]);
    out.push({
      ...item,
      email: user?.email ?? null,
      displayName: user?.displayName ?? null,
      status: user?.status ?? "deleted",
    });
  }
  return out.sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
}

/** Loose IP check for the admin search box: digits/hex, dots and colons only. */
export function looksLikeIp(value) {
  const text = String(value || "").trim();
  return text.length >= 3 && text.length <= 64 && /^[0-9a-fA-F:.]+$/.test(text) && /[.:]/.test(text);
}
