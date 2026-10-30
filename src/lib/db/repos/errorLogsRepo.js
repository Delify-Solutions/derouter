import { randomBytes } from "node:crypto";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { getSettings, updateSettings } from "./settingsRepo.js";

export const ERROR_LOG_SOURCES = ["upstream", "platform", "request", "router", "stream"];

export const ERROR_LOG_DEFAULTS = {
  enabled: true,
  // Off keeps the facts (error, model, size, attempts) but not the prompt text.
  storePrompt: true,
  retentionDays: 14,
  maxRows: 1000,
  maxBodyKB: 64,
};

const LIMITS = {
  retentionDays: [1, 365],
  maxRows: [100, 20000],
  maxBodyKB: [4, 1024],
};

function clampInt(value, [min, max], fallback) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export async function getErrorLogConfig() {
  const s = await getSettings();
  return {
    enabled: s.errorLogEnabled !== false,
    storePrompt: s.errorLogStorePrompt !== false,
    retentionDays: clampInt(s.errorLogRetentionDays, LIMITS.retentionDays, ERROR_LOG_DEFAULTS.retentionDays),
    maxRows: clampInt(s.errorLogMaxRows, LIMITS.maxRows, ERROR_LOG_DEFAULTS.maxRows),
    maxBodyKB: clampInt(s.errorLogMaxBodyKB, LIMITS.maxBodyKB, ERROR_LOG_DEFAULTS.maxBodyKB),
  };
}

/** Validates and stores the editable part of the config; unknown fields are ignored. */
export async function setErrorLogConfig(input = {}) {
  const current = await getErrorLogConfig();
  const updates = {};
  if (typeof input.enabled === "boolean") updates.errorLogEnabled = input.enabled;
  if (typeof input.storePrompt === "boolean") updates.errorLogStorePrompt = input.storePrompt;
  if (input.retentionDays != null) updates.errorLogRetentionDays = clampInt(input.retentionDays, LIMITS.retentionDays, current.retentionDays);
  if (input.maxRows != null) updates.errorLogMaxRows = clampInt(input.maxRows, LIMITS.maxRows, current.maxRows);
  if (input.maxBodyKB != null) updates.errorLogMaxBodyKB = clampInt(input.maxBodyKB, LIMITS.maxBodyKB, current.maxBodyKB);
  if (Object.keys(updates).length) await updateSettings(updates);
  return getErrorLogConfig();
}

// Sortable by time, unique enough for a debug log.
function newId() {
  return `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

const LIST_COLUMNS = `id, timestamp, source, status, endpoint, requestedModel, provider, model, connectionId,
  connectionName, apiKeyId, owner, errorCode, message, stream, bodyBytes, estTokens, messageCount, latencyMs`;

/**
 * @param {object} row columns of errorLogs except id/data, plus `data` (object)
 * @returns {Promise<string>} the new id
 */
export async function insertErrorLog(row) {
  const db = await getAdapter();
  const id = newId();
  db.run(
    `INSERT INTO errorLogs(id, timestamp, source, status, endpoint, requestedModel, provider, model, connectionId,
       connectionName, apiKeyId, owner, errorCode, message, stream, bodyBytes, estTokens, messageCount, latencyMs, data)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      row.timestamp || new Date().toISOString(),
      row.source,
      Number(row.status) || 0,
      row.endpoint ?? null,
      row.requestedModel ?? null,
      row.provider ?? null,
      row.model ?? null,
      row.connectionId ?? null,
      row.connectionName ?? null,
      row.apiKeyId ?? null,
      row.owner ?? null,
      row.errorCode ?? null,
      row.message ?? null,
      row.stream ? 1 : 0,
      Number(row.bodyBytes) || 0,
      Number(row.estTokens) || 0,
      Number(row.messageCount) || 0,
      Number(row.latencyMs) || 0,
      stringifyJson(row.data || {}),
    ],
  );
  return id;
}

function where(filter) {
  const conds = [];
  const params = [];
  if (filter.source && ERROR_LOG_SOURCES.includes(filter.source)) { conds.push("source = ?"); params.push(filter.source); }
  if (filter.status) {
    const s = String(filter.status);
    if (/^\d$/.test(s)) { conds.push("status >= ? AND status < ?"); params.push(Number(s) * 100, Number(s) * 100 + 100); }
    else if (/^\d{3}$/.test(s)) { conds.push("status = ?"); params.push(Number(s)); }
  }
  if (filter.model) {
    conds.push("(requestedModel LIKE ? ESCAPE '\\' OR model LIKE ? ESCAPE '\\')");
    const like = `%${String(filter.model).replace(/[\\%_]/g, "\\$&")}%`;
    params.push(like, like);
  }
  if (filter.q) {
    conds.push("(message LIKE ? ESCAPE '\\' OR owner LIKE ? ESCAPE '\\' OR errorCode LIKE ? ESCAPE '\\')");
    const like = `%${String(filter.q).replace(/[\\%_]/g, "\\$&")}%`;
    params.push(like, like, like);
  }
  if (filter.since) { conds.push("timestamp >= ?"); params.push(new Date(filter.since).toISOString()); }
  return { sql: conds.length ? `WHERE ${conds.join(" AND ")}` : "", params };
}

/**
 * Newest first, keyset-paginated: pass the previous page's `nextBefore` as `before`.
 * Never selects the data blob, so a page stays small however large the prompts are.
 */
export async function listErrorLogs(filter = {}) {
  const db = await getAdapter();
  const limit = Math.min(200, Math.max(1, Math.trunc(Number(filter.limit)) || 50));
  const base = where(filter);
  const conds = base.sql ? [base.sql.replace(/^WHERE /, "")] : [];
  const params = [...base.params];
  if (filter.before) {
    // ids sort by creation time; timestamp ties are broken by id
    const [ts, id] = String(filter.before).split("|");
    conds.push("(timestamp < ? OR (timestamp = ? AND id < ?))");
    params.push(ts, ts, id || "");
  }
  const rows = db.all(
    `SELECT ${LIST_COLUMNS} FROM errorLogs ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""}
     ORDER BY timestamp DESC, id DESC LIMIT ?`,
    [...params, limit + 1],
  );
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map((r) => ({ ...r, stream: !!r.stream }));
  const last = items[items.length - 1];
  return { items, nextBefore: hasMore && last ? `${last.timestamp}|${last.id}` : null };
}

export async function getErrorLog(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT ${LIST_COLUMNS}, data FROM errorLogs WHERE id = ?`, [id]);
  if (!row) return null;
  const { data, ...rest } = row;
  return { ...rest, stream: !!rest.stream, data: parseJson(data, {}) };
}

/** Counts per source and per status class since `since` (ISO), for the page summary. */
export async function errorLogSummary(since) {
  const db = await getAdapter();
  const from = since ? new Date(since).toISOString() : "0000";
  const bySource = db.all(`SELECT source, COUNT(*) AS n FROM errorLogs WHERE timestamp >= ? GROUP BY source`, [from]);
  const total = db.get(`SELECT COUNT(*) AS n FROM errorLogs`)?.n || 0;
  return {
    total,
    since: from,
    bySource: Object.fromEntries(ERROR_LOG_SOURCES.map((s) => [s, bySource.find((r) => r.source === s)?.n || 0])),
  };
}

export async function deleteErrorLog(id) {
  const db = await getAdapter();
  return db.run(`DELETE FROM errorLogs WHERE id = ?`, [id]).changes > 0;
}

/** Deletes everything, or only rows older than `olderThanDays`. Returns the number removed. */
export async function clearErrorLogs({ olderThanDays = null } = {}) {
  const db = await getAdapter();
  if (olderThanDays == null) return db.run(`DELETE FROM errorLogs`).changes;
  const cutoff = new Date(Date.now() - Number(olderThanDays) * 86_400_000).toISOString();
  return db.run(`DELETE FROM errorLogs WHERE timestamp < ?`, [cutoff]).changes;
}

/** Drops rows past the retention age, then the oldest rows past the row cap. */
export async function pruneErrorLogs({ retentionDays, maxRows }) {
  const db = await getAdapter();
  let removed = 0;
  db.transaction(() => {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    removed += db.run(`DELETE FROM errorLogs WHERE timestamp < ?`, [cutoff]).changes;
    const over = (db.get(`SELECT COUNT(*) AS n FROM errorLogs`)?.n || 0) - maxRows;
    if (over > 0) {
      removed += db.run(
        `DELETE FROM errorLogs WHERE id IN (SELECT id FROM errorLogs ORDER BY timestamp ASC, id ASC LIMIT ?)`,
        [over],
      ).changes;
    }
  });
  return removed;
}
