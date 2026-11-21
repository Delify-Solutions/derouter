// Knowledge-base documents and chunks (spec business-bots "Knowledge base
// ingestion", "Retry and stale documents", design D8/D9).
//
// Only the extracted text is stored, as chunks; the uploaded file is never kept.
// `status` is stored as processing/ready/failed; `stale` is COMPUTED on read (a
// document with a chunk embedded by another model), because it changes the moment
// the admin edits the embedding model without any row being written.
//
// Relative imports only: tests import this under plain `node --test`.
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { utf8Bytes } from "../../biz/chunking.js";
import { businessQuotaSync, ADD_DOCUMENT_WITHOUT_PLAN } from "./bizBotsRepo.js";

export const DOCUMENT_STATUSES = ["processing", "ready", "failed"];

export const KB_OVER_QUOTA = (used, max) =>
  `Vượt dung lượng tài liệu của gói (${formatMb(used)}/${formatMb(max)})`;

/** "4.9 MB" / "20 MB" / "1.5 GB" — the unit the customer's plan speaks in. */
export function formatMb(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/, "")} GB`;
  return `${(value / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

function rowToDocument(row, currentModel = null) {
  if (!row) return null;
  const status = DOCUMENT_STATUSES.includes(row.status) ? row.status : "failed";
  // Stale wins over a stored status: a ready document whose chunks came from
  // another embedding model answers nothing until it is retried.
  const stale = status !== "processing" && currentModel != null && row.staleCount > 0;
  return {
    id: row.id,
    botId: row.botId,
    userId: row.userId,
    title: row.title,
    sourceType: row.sourceType,
    mime: row.mime ?? null,
    bytes: Number(row.bytes) || 0,
    status: stale ? "stale" : status,
    error: row.error ?? null,
    chunkCount: Number(row.chunkCount) || 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Documents of a bot with `stale` computed against the current embedding model. */
export function listDocumentsSync(db, botId, currentModel = null) {
  const rows = db.all(
    `SELECT d.*,
            (SELECT COUNT(*) FROM bizChunks c
              WHERE c.docId = d.id AND c.embedding IS NOT NULL
                AND (c.embeddingModel IS NULL OR c.embeddingModel != ?)) AS staleCount
       FROM bizDocuments d
      WHERE d.botId = ?
      ORDER BY d.createdAt DESC`,
    [currentModel ?? "", botId]
  );
  return rows.map((row) => rowToDocument(row, currentModel));
}

export function getDocumentSync(db, id, currentModel = null) {
  const row = db.get(
    `SELECT d.*,
            (SELECT COUNT(*) FROM bizChunks c
              WHERE c.docId = d.id AND c.embedding IS NOT NULL
                AND (c.embeddingModel IS NULL OR c.embeddingModel != ?)) AS staleCount
       FROM bizDocuments d WHERE d.id = ?`,
    [currentModel ?? "", id]
  );
  return rowToDocument(row, currentModel);
}

/**
 * Create a document and its chunks in ONE transaction, after the knowledge-base
 * size check (spec "Nothing SHALL be stored in that case").
 *
 * @param {object} input
 *   `{ botId, userId, title, sourceType, mime, text, chunks, status, error }`
 *   `chunks` are the already-built chunk texts (`text` is only used for `bytes`).
 * @returns {{ ok:true, document:object } | { ok:false, status:number, error:string }}
 */
export function createDocumentSync(db, input, { currentModel = null, nowIso = new Date().toISOString() } = {}) {
  const {
    botId, userId, title, sourceType, mime = null, text = "", chunks = [],
    status = "processing", error = null,
  } = input;

  // Adding to the knowledge base needs a LIVE business plan; an expired one keeps
  // what is already there and refuses nothing new (spec business-bots "Knowledge
  // base ingestion").
  const quota = businessQuotaSync(db, userId, nowIso);
  if (!quota.hasBusinessPlan) return { ok: false, status: 403, error: ADD_DOCUMENT_WITHOUT_PLAN };

  const bytes = utf8Bytes(text);
  // A live business plan with NULL/0 maxKbBytes grants no knowledge base at all
  // (spec business-bots: "A NULL or 0 value on a plan SHALL count as 0"), so the
  // comparison is unconditional rather than skipping the check.
  const maxKbBytes = quota.maxKbBytes || 0;
  if (quota.kbBytesUsed + bytes > maxKbBytes) {
    return { ok: false, status: 413, error: KB_OVER_QUOTA(quota.kbBytesUsed, maxKbBytes) };
  }

  const document = {
    id: uuidv4(),
    botId,
    userId,
    title: String(title ?? "").trim() || "Tài liệu",
    sourceType,
    mime,
    bytes,
    status: DOCUMENT_STATUSES.includes(status) ? status : "processing",
    error,
    chunkCount: chunks.length,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  db.transaction(() => {
    db.run(
      `INSERT INTO bizDocuments(id, botId, userId, title, sourceType, mime, bytes, status, error, chunkCount, createdAt, updatedAt)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        document.id, document.botId, document.userId, document.title, document.sourceType, document.mime,
        document.bytes, document.status, document.error, document.chunkCount, document.createdAt, document.updatedAt,
      ]
    );
    chunks.forEach((chunk, ord) => {
      db.run(
        `INSERT INTO bizChunks(docId, botId, ord, text, embedding, embeddingModel, dims) VALUES(?, ?, ?, ?, NULL, NULL, NULL)`,
        [document.id, botId, ord, chunk]
      );
    });
  });

  // `stale` is computed on read; a just-created document matches the current model.
  return { ok: true, document: getDocumentSync(db, document.id, currentModel) ?? document };
}

/** Delete a document and its chunks in one transaction. */
export function deleteDocumentSync(db, id) {
  let deleted = false;
  db.transaction(() => {
    db.run(`DELETE FROM bizChunks WHERE docId = ?`, [id]);
    const res = db.run(`DELETE FROM bizDocuments WHERE id = ?`, [id]);
    deleted = (res?.changes ?? 0) > 0;
  });
  return deleted;
}

/**
 * Set a document back to `processing` so the ingest worker re-embeds its stored
 * chunks. Only a `failed` or `stale` document may be retried (409 otherwise).
 *
 * @returns {{ ok:true, document:object } | { ok:false, status:number, error:string }}
 */
export function retryDocumentSync(db, id, { currentModel = null, nowIso = new Date().toISOString() } = {}) {
  const current = getDocumentSync(db, id, currentModel);
  if (!current) return { ok: false, status: 404, error: "Không tìm thấy tài liệu" };
  // Only a failed or stale document may be retried; anything else is 409 (spec
  // "Retry and stale documents"). A document left `processing` by a crash is
  // resumed by the ingestion worker's startup sweep, not by a manual retry.
  if (current.status !== "failed" && current.status !== "stale") {
    return { ok: false, status: 409, error: "Chỉ xử lý lại được tài liệu lỗi hoặc cần xử lý lại" };
  }

  db.transaction(() => {
    db.run(`UPDATE bizDocuments SET status = 'processing', error = NULL, updatedAt = ? WHERE id = ?`, [nowIso, id]);
    // A stale retry invalidates the old embeddings: keeping them would let the
    // worker skip the chunk it must redo.
    db.run(
      `UPDATE bizChunks SET embedding = NULL, embeddingModel = NULL, dims = NULL
        WHERE docId = ? AND embeddingModel IS NOT NULL AND embeddingModel != ?`,
      [id, currentModel ?? ""]
    );
  });
  return { ok: true, document: getDocumentSync(db, id, currentModel) };
}

// ── Ingestion worker helpers ────────────────────────────────────────────────

/** Documents still needing embeddings, oldest first. */
export function pendingDocumentsSync(db, limit = 32) {
  return db.all(
    `SELECT * FROM bizDocuments WHERE status = 'processing' ORDER BY createdAt ASC LIMIT ?`,
    [Math.max(1, Math.floor(limit))]
  );
}

/** Chunks of one document that have no embedding yet. */
export function pendingChunksSync(db, docId, limit = 32) {
  return db.all(
    `SELECT id, text FROM bizChunks WHERE docId = ? AND embedding IS NULL ORDER BY ord ASC LIMIT ?`,
    [docId, Math.max(1, Math.floor(limit))]
  );
}

/** Write one chunk's embedding. */
export function saveChunkEmbeddingSync(db, chunkId, { embedding, embeddingModel, dims }) {
  db.run(`UPDATE bizChunks SET embedding = ?, embeddingModel = ?, dims = ? WHERE id = ?`, [
    embedding, embeddingModel, dims, chunkId,
  ]);
}

/**
 * Close out a document: `ready` when every chunk carries an embedding of
 * `embeddingModel`, else `failed` with `error`. Chunks are always kept (spec
 * "The chunks already extracted SHALL be kept").
 */
export function finishDocumentSync(db, docId, { embeddingModel, error = null, nowIso = new Date().toISOString() } = {}) {
  const row = db.get(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN embedding IS NOT NULL AND embeddingModel = ? THEN 1 ELSE 0 END), 0) AS done
       FROM bizChunks WHERE docId = ?`,
    [embeddingModel ?? "", docId]
  );
  const total = Number(row?.total) || 0;
  const done = Number(row?.done) || 0;
  if (!error && total > 0 && done === total) {
    db.run(`UPDATE bizDocuments SET status = 'ready', error = NULL, chunkCount = ?, updatedAt = ? WHERE id = ?`, [
      total, nowIso, docId,
    ]);
    return "ready";
  }
  db.run(`UPDATE bizDocuments SET status = 'failed', error = ?, updatedAt = ? WHERE id = ?`, [
    error || "Không tạo được embedding cho tài liệu", nowIso, docId,
  ]);
  return "failed";
}

/** Mark a document failed without touching its chunks. */
export function failDocumentSync(db, docId, error, nowIso = new Date().toISOString()) {
  db.run(`UPDATE bizDocuments SET status = 'failed', error = ?, updatedAt = ? WHERE id = ?`, [
    String(error || "Không tạo được embedding cho tài liệu").slice(0, 500), nowIso, docId,
  ]);
}

/** The bot's chunks for one embedding model, for retrieval (design D7). */
export function chunksForModelSync(db, botId, embeddingModel) {
  return db.all(
    `SELECT id, docId, text, embedding, dims FROM bizChunks
      WHERE botId = ? AND embeddingModel = ? ORDER BY docId ASC, ord ASC`,
    [botId, embeddingModel]
  );
}

/** Every chunk that already carries an embedding, for the cache's invalidation stamp. */
export function chunkStampSync(db, botId) {
  const row = db.get(
    `SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS maxId FROM bizChunks WHERE botId = ? AND embedding IS NOT NULL`,
    [botId]
  );
  return `${Number(row?.n) || 0}:${Number(row?.maxId) || 0}`;
}

// ── Async wrappers used by the routes ───────────────────────────────────────

export async function listDocuments(botId, currentModel = null) {
  return listDocumentsSync(await getAdapter(), botId, currentModel);
}

export async function getDocument(id, currentModel = null) {
  return getDocumentSync(await getAdapter(), id, currentModel);
}

export async function createDocument(input, options = {}) {
  const db = await getAdapter();
  return createDocumentSync(db, input, options);
}

export async function deleteDocument(id) {
  return deleteDocumentSync(await getAdapter(), id);
}

export async function retryDocument(id, options = {}) {
  const db = await getAdapter();
  return retryDocumentSync(db, id, options);
}

/** Guard events of one bot, newest first (spec business-guard "Guard event log"). */
export function listGuardEventsSync(db, botId, limit = 100) {
  return db
    .all(
      `SELECT id, botId, apiKeyId, category, excerpt, createdAt FROM bizGuardEvents
        WHERE botId = ? ORDER BY createdAt DESC, id DESC LIMIT ?`,
      [botId, Math.max(1, Math.floor(limit))]
    )
    .map((row) => ({
      id: row.id,
      botId: row.botId,
      apiKeyId: row.apiKeyId ?? null,
      category: row.category,
      excerpt: row.excerpt ?? "",
      createdAt: row.createdAt,
    }));
}

/** Record one guard event. Never throws: logging must not break the reply path. */
export function recordGuardEventSync(db, { botId, apiKeyId = null, category, excerpt = "", nowIso = new Date().toISOString() }) {
  if (!botId || !category) return false;
  db.run(
    `INSERT INTO bizGuardEvents(botId, apiKeyId, category, excerpt, createdAt) VALUES(?, ?, ?, ?, ?)`,
    [botId, apiKeyId, String(category), String(excerpt ?? "").slice(0, 200), nowIso]
  );
  return true;
}

export async function listGuardEvents(botId, limit = 100) {
  return listGuardEventsSync(await getAdapter(), botId, limit);
}

export async function recordGuardEvent(event) {
  try {
    return recordGuardEventSync(await getAdapter(), event);
  } catch {
    return false;
  }
}

/** Blocked-question count over a window, for the admin bot overview. */
export function blockedCountSync(db, botId, sinceIso) {
  return Number(
    db.get(`SELECT COUNT(*) AS n FROM bizGuardEvents WHERE botId = ? AND createdAt >= ?`, [botId, sinceIso])?.n
  ) || 0;
}

/** Document counts by (computed) status, for the admin bot overview. */
export function documentCountsSync(db, botId, currentModel = null) {
  const docs = listDocumentsSync(db, botId, currentModel);
  const counts = { processing: 0, ready: 0, failed: 0, stale: 0 };
  for (const doc of docs) counts[doc.status] = (counts[doc.status] ?? 0) + 1;
  return counts;
}
