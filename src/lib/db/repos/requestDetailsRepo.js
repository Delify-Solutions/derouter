import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { keyOwnerSnapshotSync } from "./apiKeysRepo.js";

const DEFAULT_MAX_RECORDS = 200;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_JSON_SIZE = 5 * 1024;
const CONFIG_CACHE_TTL_MS = 5000;

let cachedConfig = null;
let cachedConfigTs = 0;

async function getObservabilityConfig() {
  if (cachedConfig && (Date.now() - cachedConfigTs) < CONFIG_CACHE_TTL_MS) return cachedConfig;
  try {
    const { getSettings } = await import("./settingsRepo.js");
    const settings = await getSettings();
    const envRequestLogs = process.env.ENABLE_REQUEST_LOGS;
    if (envRequestLogs !== undefined) {
      const enabled = envRequestLogs.toLowerCase() === "true";
      cachedConfig = {
        enabled,
        maxRecords: settings.observabilityMaxRecords || parseInt(process.env.OBSERVABILITY_MAX_RECORDS || String(DEFAULT_MAX_RECORDS), 10),
        batchSize: settings.observabilityBatchSize || parseInt(process.env.OBSERVABILITY_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10),
        flushIntervalMs: settings.observabilityFlushIntervalMs || parseInt(process.env.OBSERVABILITY_FLUSH_INTERVAL_MS || String(DEFAULT_FLUSH_INTERVAL_MS), 10),
        maxJsonSize: (settings.observabilityMaxJsonSize || parseInt(process.env.OBSERVABILITY_MAX_JSON_SIZE || "5", 10)) * 1024,
      };
      cachedConfigTs = Date.now();
      return cachedConfig;
    }
    const envFallback = process.env.OBSERVABILITY_ENABLED !== "false";
    const uiFlag = typeof settings.enableObservability === "boolean";
    const enabled = uiFlag
      ? settings.enableObservability
      : envFallback;

    cachedConfig = {
      enabled,
      maxRecords: settings.observabilityMaxRecords || parseInt(process.env.OBSERVABILITY_MAX_RECORDS || String(DEFAULT_MAX_RECORDS), 10),
      batchSize: settings.observabilityBatchSize || parseInt(process.env.OBSERVABILITY_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10),
      flushIntervalMs: settings.observabilityFlushIntervalMs || parseInt(process.env.OBSERVABILITY_FLUSH_INTERVAL_MS || String(DEFAULT_FLUSH_INTERVAL_MS), 10),
      maxJsonSize: (settings.observabilityMaxJsonSize || parseInt(process.env.OBSERVABILITY_MAX_JSON_SIZE || "5", 10)) * 1024,
    };
  } catch {
    cachedConfig = {
      enabled: false,
      maxRecords: DEFAULT_MAX_RECORDS,
      batchSize: DEFAULT_BATCH_SIZE,
      flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
      maxJsonSize: DEFAULT_MAX_JSON_SIZE,
    };
  }
  cachedConfigTs = Date.now();
  return cachedConfig;
}

let writeBuffer = [];
let flushTimer = null;
let isFlushing = false;

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const sensitiveKeys = ["authorization", "x-api-key", "cookie", "token", "api-key"];
  const sanitized = { ...headers };
  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) delete sanitized[key];
  }
  return sanitized;
}

export const __test__ = { sanitizeHeaders, generateDetailId, truncateField: (obj, maxSize) => truncateField(obj, maxSize) };

// A timestamp and a random suffix. The model is NOT part of the id: ids are shown
// to key holders, and the stored model is the upstream one (spec model-privacy).
// Rows written before this change keep their old ids (which do embed the model);
// the public usage API never returns a stored id to a customer key.
function generateDetailId() {
  const timestamp = new Date().toISOString();
  let random = "";
  while (random.length < 12) random += Math.random().toString(36).slice(2);
  return `${timestamp}-${random.slice(0, 12)}`;
}

function truncateField(obj, maxSize) {
  const str = JSON.stringify(obj || {});
  if (str.length > maxSize) {
    // A stored request's `model` is the upstream one (it is recorded after combo
    // expansion). Inside the cut preview string it could only be scrubbed as
    // text; kept as a field of its own it is an ordinary model field, which the
    // public usage API rewrites for a customer key (spec model-privacy) and an
    // admin still reads. The preview is cut from the rest.
    const isObject = obj && typeof obj === "object" && !Array.isArray(obj);
    if (isObject && typeof obj.model === "string") {
      const { model, ...rest } = obj;
      return { _truncated: true, _originalSize: str.length, model, _preview: JSON.stringify(rest).substring(0, 200) };
    }
    return { _truncated: true, _originalSize: str.length, _preview: str.substring(0, 200) };
  }
  return obj || {};
}

async function flushToDatabase() {
  if (isFlushing) return;
  if (writeBuffer.length === 0) return;
  isFlushing = true;
  try {
    // Drain entire buffer (loop in case more pushed during await)
    while (writeBuffer.length > 0) {
      const items = writeBuffer.splice(0, writeBuffer.length);
      const db = await getAdapter();
      const config = await getObservabilityConfig();

      db.transaction(() => {
        // One owner lookup per distinct key per flush.
        const owners = new Map();
        const ownerOf = (key) => {
          if (!key) return null;
          if (!owners.has(key)) owners.set(key, keyOwnerSnapshotSync(db, key));
          return owners.get(key);
        };
        for (const item of items) {
          if (!item.id) item.id = generateDetailId();
          if (!item.timestamp) item.timestamp = new Date().toISOString();
          if (item.request?.headers) item.request.headers = sanitizeHeaders(item.request.headers);

          const record = {
            id: item.id,
            provider: item.provider || null,
            model: item.model || null,
            // Preserve the original client model string (bare combo name) so the
            // public /usage detail view can show the combo the key holder called,
            // not the internal pool/fallback model the proxy resolved to.
            requestedModel: item.requestedModel || null,
            connectionId: item.connectionId || null,
            apiKey: item.apiKey || null,
            timestamp: item.timestamp,
            status: item.status || null,
            latency: item.latency || {},
            tokens: item.tokens || {},
            request: truncateField(item.request, config.maxJsonSize),
            providerRequest: truncateField(item.providerRequest, config.maxJsonSize),
            providerResponse: truncateField(item.providerResponse, config.maxJsonSize),
            response: truncateField(item.response, config.maxJsonSize),
            pxpipe: item.pxpipe || undefined,
            // Who owned the key when the request ran (see the requestDetails
            // columns): the admin view still names the customer after the key
            // is deleted.
            owner: ownerOf(item.apiKey) || undefined,
          };

          db.run(
            `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, apiKey, status, data, userId, apiKeyId, requestedModel) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET timestamp = excluded.timestamp, provider = excluded.provider, model = excluded.model, connectionId = excluded.connectionId, apiKey = excluded.apiKey, status = excluded.status, data = excluded.data, userId = excluded.userId, apiKeyId = excluded.apiKeyId, requestedModel = excluded.requestedModel`,
            [
              record.id, record.timestamp, record.provider, record.model, record.connectionId, record.apiKey,
              record.status, stringifyJson(record), record.owner?.userId ?? null, record.owner?.apiKeyId ?? null,
              record.requestedModel,
            ]
          );
        }

        const cnt = db.get(`SELECT COUNT(*) as c FROM requestDetails`);
        if (cnt && cnt.c > config.maxRecords) {
          db.run(
            `DELETE FROM requestDetails WHERE id IN (SELECT id FROM requestDetails ORDER BY timestamp ASC LIMIT ?)`,
            [cnt.c - config.maxRecords]
          );
        }
      });
    }
  } catch (e) {
    console.error("[requestDetailsRepo] Batch write failed:", e);
  } finally {
    isFlushing = false;
  }
}

export async function saveRequestDetail(detail) {
  const config = await getObservabilityConfig();
  if (!config.enabled) {return;}

  writeBuffer.push(detail);

  // Trigger immediate flush if batch threshold reached.
  // flushToDatabase() drains entire buffer in a loop, so all pushes during await are persisted.
  if (writeBuffer.length >= config.batchSize) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flushToDatabase().catch((e) => console.error("[requestDetailsRepo] flush err:", e));
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushToDatabase().catch(() => {});
    }, config.flushIntervalMs);
  }
}

// Rows written before requestDetails.requestedModel existed carry the requested model
// only in their JSON. Copied into the column once per process (per adapter), on the first
// listing. The table is capped by observabilityMaxRecords, so one statement is cheap.
const requestedModelBackfilled = new WeakSet();

export function backfillRequestedModelSync(db) {
  if (requestedModelBackfilled.has(db)) return;
  requestedModelBackfilled.add(db);
  try {
    db.run(
      `UPDATE requestDetails SET requestedModel = json_extract(data, '$.requestedModel')
        WHERE requestedModel IS NULL AND json_valid(data)`
    );
  } catch (e) {
    console.error("[requestDetailsRepo] requestedModel backfill failed:", e.message);
  }
}

// ─── Listing: model view, model filter, sort (spec admin-usage-views) ──────────────
export const DETAIL_MODEL_VIEWS = ["requested", "upstream"];
export const DETAIL_SORTS = ["time", "tokens", "latency"];
export const DETAIL_ORDERS = ["desc", "asc"];

const DATA_JSON = "CASE WHEN json_valid(data) THEN data END";
const tokenField = (name) => `json_extract(${DATA_JSON}, '$.tokens.${name}')`;
// Input + output tokens; NULL when the row records neither, so it sorts last.
const TOKENS_SORT_SQL = `CASE
    WHEN COALESCE(${tokenField("prompt_tokens")}, ${tokenField("input_tokens")},
                  ${tokenField("completion_tokens")}, ${tokenField("output_tokens")}) IS NULL THEN NULL
    ELSE COALESCE(${tokenField("prompt_tokens")}, ${tokenField("input_tokens")}, 0)
       + COALESCE(${tokenField("completion_tokens")}, ${tokenField("output_tokens")}, 0)
  END`;
const LATENCY_SORT_SQL = `json_extract(${DATA_JSON}, '$.latency.total')`;
const SORT_SQL = { tokens: TOKENS_SORT_SQL, latency: LATENCY_SORT_SQL };

/** The model a row is listed under in a view: requested (else upstream) or upstream. */
function modelExprOf(view) {
  return view === "requested" ? "COALESCE(NULLIF(requestedModel, ''), model)" : "model";
}

function orderByOf(sort, order) {
  const dir = order === "asc" ? "ASC" : "DESC";
  const expr = SORT_SQL[sort];
  // Time is NOT NULL. Tokens and latency put rows without the figure last in both
  // directions, then break ties by time, newest first.
  if (!expr) return `ORDER BY timestamp ${dir}`;
  return `ORDER BY (${expr}) IS NULL, ${expr} ${dir}, timestamp DESC`;
}

// Free-text search (`q`). Case folding: SQLite's lower()/LIKE only fold ASCII, so
// "Đức" would never match "đức"; a user-defined SQL function is not available on every
// adapter (bun:sqlite has none). The search therefore folds in JS — full Unicode case
// mapping, NFC so a decomposed "ữ" matches a composed one. The table is capped by
// observabilityMaxRecords (default 1000), but the cap is an admin setting with no upper
// bound, so the scan reads SEARCH_SLICE_ROWS rows at a time (rowid order) and yields to
// the event loop between slices: no single turn lasts longer than one slice.
const foldText = (s) => String(s ?? "").normalize("NFC").toLowerCase();
const SEARCH_SLICE_ROWS = 2000;
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

/** Ids of the rows matching `conds` whose model names, provider or key owner contain `q`. */
async function searchIds(db, conds, params, q, sliceRowsOption) {
  // At least one row per slice: 0, a negative or a non-number would never advance.
  const sliceRows = Math.max(1, Math.floor(Number(sliceRowsOption ?? SEARCH_SLICE_ROWS)) || SEARCH_SLICE_ROWS);
  const needle = foldText(q).trim();
  const ids = [];
  const where = [...conds, "rowid > ?"].join(" AND ");
  for (let after = Number.MIN_SAFE_INTEGER; ;) {
    const rows = db.all(
      `SELECT rowid AS rid, id, model, requestedModel, provider,
              json_extract(${DATA_JSON}, '$.owner.email') AS email,
              json_extract(${DATA_JSON}, '$.owner.displayName') AS displayName,
              json_extract(${DATA_JSON}, '$.owner.keyName') AS keyName
         FROM requestDetails WHERE ${where} ORDER BY rowid LIMIT ?`,
      [...params, after, sliceRows]
    );
    for (const r of rows) {
      if ([r.model, r.requestedModel, r.provider, r.email, r.displayName, r.keyName].some((v) => foldText(v).includes(needle))) {
        ids.push(r.id);
      }
    }
    if (rows.length < sliceRows) return ids;
    after = rows[rows.length - 1].rid;
    await yieldToLoop();
  }
}

/**
 * Stored request details, newest first by default.
 *
 * filter: provider, model, connectionId, apiKey, userId, status, startDate, endDate,
 * page, pageSize, plus
 *   modelView  "requested" | "upstream" (default "upstream"): which model `model` matches;
 *   q          free-text search over the model names, provider and the key owner snapshot
 *              (scanned in slices of `searchSliceRows` rows, default 2000, yielding between);
 *   sort       "time" | "tokens" | "latency" (default "time");
 *   order      "desc" | "asc" (default "desc");
 *   includeModels  also return `models`, the distinct models of the view (at most 500).
 * Filtering and sorting apply before pagination. Unknown sort/order values fall back to
 * the defaults (the admin route rejects them before calling).
 */
export async function getRequestDetails(filter = {}) {
  const db = await getAdapter();
  backfillRequestedModelSync(db);
  const modelView = filter.modelView === "requested" ? "requested" : "upstream";
  const conds = [];
  const params = [];

  if (filter.provider) { conds.push("provider = ?"); params.push(filter.provider); }
  if (filter.model) { conds.push(`${modelExprOf(modelView)} = ?`); params.push(filter.model); }
  if (filter.connectionId) { conds.push("connectionId = ?"); params.push(filter.connectionId); }
  if (filter.apiKey) { conds.push("apiKey = ?"); params.push(filter.apiKey); }
  // Every key a customer owns (spec admin-user-management "Request details show the key owner").
  // Rows carry the owner snapshotted at request time, so a deleted key's requests
  // stay listed; rows written before the snapshot existed fall back to the live
  // key list.
  if (filter.userId) {
    conds.push("(userId = ? OR (userId IS NULL AND apiKey IN (SELECT key FROM apiKeys WHERE userId = ?)))");
    params.push(filter.userId, filter.userId);
  }
  // Status filter: empty/full status value → exact match (e.g. "429"); a single
  // leading digit ("2","4","5") → prefix match so selecting "4xx" shows every
  // 4xx row. Non-numeric statuses ("error","ok") fall through to exact match.
  if (filter.status) {
    const s = String(filter.status);
    if (/^\d$/.test(s)) { conds.push("status LIKE ?"); params.push(`${s}%`); }
    else { conds.push("status = ?"); params.push(s); }
  }
  if (filter.startDate) { conds.push("timestamp >= ?"); params.push(new Date(filter.startDate).toISOString()); }
  if (filter.endDate) { conds.push("timestamp <= ?"); params.push(new Date(filter.endDate).toISOString()); }

  if (filter.q && String(filter.q).trim()) {
    const ids = await searchIds(db, conds, params, filter.q, filter.searchSliceRows);
    // One JSON parameter, whatever the number of matches (no bound-variable limit).
    conds.push("id IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(ids));
  }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const cntRow = db.get(`SELECT COUNT(*) as c FROM requestDetails ${where}`, params);
  const totalItems = cntRow ? cntRow.c : 0;

  const page = filter.page || 1;
  const pageSize = filter.pageSize || 50;
  const totalPages = Math.ceil(totalItems / pageSize);
  const offset = (page - 1) * pageSize;

  const sort = DETAIL_SORTS.includes(filter.sort) ? filter.sort : "time";
  const order = DETAIL_ORDERS.includes(filter.order) ? filter.order : "desc";
  const rows = db.all(
    `SELECT data FROM requestDetails ${where} ${orderByOf(sort, order)} LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const details = rows.map((r) => parseJson(r.data, {}));

  const result = {
    details,
    pagination: { page, pageSize, totalItems, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
  };
  if (filter.includeModels) {
    const expr = modelExprOf(modelView);
    result.models = db.all(
      `SELECT DISTINCT ${expr} AS m FROM requestDetails WHERE COALESCE(${expr}, '') != '' ORDER BY m ASC LIMIT 500`
    ).map((r) => r.m);
  }
  return result;
}

export async function getDistinctProviders() {
  const db = await getAdapter();
  const rows = db.all(`SELECT DISTINCT provider FROM requestDetails WHERE provider IS NOT NULL ORDER BY provider ASC`);
  return rows.map((r) => r.provider);
}

/**
 * One detail by its id, only when it belongs to `apiKey` (the public usage API:
 * a key holder never reads another key's row). Indexed by the primary key.
 */
export async function getRequestDetailForKey(id, apiKey) {
  if (!id || !apiKey) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM requestDetails WHERE id = ? AND apiKey = ?`, [id, apiKey]);
  return row ? parseJson(row.data, null) : null;
}

export async function getRequestDetailById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM requestDetails WHERE id = ?`, [id]);
  return row ? parseJson(row.data, null) : null;
}

/**
 * Clear ALL request-detail log rows (admin "Clear all request logs" button).
 * Flushes the in-memory write buffer first so pending writes don't re-populate
 * the table after the truncate. Returns the number of rows deleted.
 *
 * `usageHistory` (usage accounting) is intentionally NOT cleared — this is the
 * request-log table, not the billing/usage ledger.
 */
export async function clearAllRequestDetails() {
  // Drain any buffered writes first; otherwise a pending flush would resurrect
  // rows right after we delete them.
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (writeBuffer.length > 0) {
    await flushToDatabase().catch(() => {});
  }
  const db = await getAdapter();
  let deleted = 0;
  db.transaction(() => {
    const row = db.get(`SELECT COUNT(*) AS c FROM requestDetails`);
    deleted = row ? row.c : 0;
    db.run(`DELETE FROM requestDetails`);
  });
  return deleted;
}

const _shutdownHandler = async () => {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (writeBuffer.length > 0) await flushToDatabase();
};

function ensureShutdownHandler() {
  process.off("beforeExit", _shutdownHandler);
  process.off("SIGINT", _shutdownHandler);
  process.off("SIGTERM", _shutdownHandler);
  process.off("exit", _shutdownHandler);

  process.on("beforeExit", _shutdownHandler);
  process.on("SIGINT", _shutdownHandler);
  process.on("SIGTERM", _shutdownHandler);
  process.on("exit", _shutdownHandler);
}

ensureShutdownHandler();
