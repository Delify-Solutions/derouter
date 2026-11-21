// Retrieval over a bot's knowledge base (spec business-bots "Retrieval", design D7).
//
// Brute force: embed the question, decode the bot's chunks for the current
// embedding model and keep the top 5 at or above the admin threshold. A decoded
// vector cache keeps the repeated scans cheap; it is invalidated when the bot's
// chunk set changes (a document added, deleted, re-embedded) or the embedding model
// changes.
//
// The cache is bounded in BYTES, not entries: at 1,536 dims a vector is 6 KB, so
// an entry cap would bound the wrong thing.
import { getAdapter } from "../db/driver.js";
import { chunksForModelSync, chunkStampSync } from "../db/repos/bizDocumentsRepo.js";
import { decodeVector, topK, vectorBytes } from "./vector.js";
import { embedOne } from "./internalCall.js";

export const RETRIEVAL_TOP_K = 5;
export const DEFAULT_THRESHOLD = 0.3;
export const CACHE_MAX_BYTES = 200 * 1024 * 1024;

const g = (globalThis.__bizVectorCache ??= { entries: new Map(), bytes: 0 });

function touch(key) {
  const entry = g.entries.get(key);
  if (entry) {
    g.entries.delete(key);
    g.entries.set(key, entry);
  }
  return entry;
}

function evict(key) {
  const entry = g.entries.get(key);
  if (!entry) return;
  g.entries.delete(key);
  g.bytes -= entry.bytes;
}

/** Drop one bot's cached vectors (a document changed, or the model changed). */
export function invalidateBotCache(botId) {
  for (const [key, entry] of [...g.entries]) {
    if (entry.botId === botId) {
      g.entries.delete(key);
      g.bytes -= entry.bytes;
    }
  }
}

/** Drop everything — tests only; a running server never calls this. */
export function clearVectorCache() {
  g.entries.clear();
  g.bytes = 0;
}

export function vectorCacheStats() {
  return { entries: g.entries.size, bytes: g.bytes };
}

/**
 * Decoded chunks of one bot for one embedding model, memoised on the chunk set.
 * `stamp` is `<count>:<maxId>` of the bot's embedded chunks, so any insert, delete
 * or re-embed changes it.
 */
function cachedChunks(botId, embeddingModel, stamp, rows) {
  const key = `${botId}|${embeddingModel}|${stamp}`;
  const hit = touch(key);
  if (hit) return hit.chunks;

  const chunks = [];
  for (const row of rows) {
    const embedding = decodeVector(row.embedding, row.dims);
    if (!embedding) continue;
    chunks.push({ id: row.id, docId: row.docId, text: row.text, embedding });
  }
  const bytes = chunks.reduce((total, chunk) => total + vectorBytes(chunk.embedding), 0);
  // A single bot over the cap is simply not cached; it is still scanned.
  if (bytes > 0 && bytes <= CACHE_MAX_BYTES) {
    while (g.bytes + bytes > CACHE_MAX_BYTES && g.entries.size > 0) {
      const oldest = g.entries.keys().next().value;
      if (oldest === undefined) break;
      evict(oldest);
    }
    g.entries.set(key, { botId, chunks, bytes });
    g.bytes += bytes;
  }
  return chunks;
}

/**
 * Top chunks for a question.
 *
 * @param {{ botId:string, question:string, embeddingModel:string,
 *           threshold?:number, topK?:number, embed?:(model:string, text:string)=>Promise<Float32Array> }} args
 * @returns {Promise<Array<{ id:number, docId:string, text:string, score:number }>>}
 */
export async function retrieve({
  botId,
  question,
  embeddingModel,
  threshold = DEFAULT_THRESHOLD,
  topK: limit = RETRIEVAL_TOP_K,
  embed = embedOne,
} = {}) {
  if (!botId || !question || !embeddingModel) return [];
  const db = await getAdapter();
  const rows = chunksForModelSync(db, botId, embeddingModel);
  if (rows.length === 0) return [];

  const questionVector = await embed(embeddingModel, question);
  const chunks = cachedChunks(botId, embeddingModel, chunkStampSync(db, botId), rows);
  if (chunks.length === 0) return [];

  return topK(questionVector, chunks, { topK: limit, threshold }).map(({ item, score }) => ({
    id: item.id,
    docId: item.docId,
    text: item.text,
    score,
  }));
}
