// Float32 vectors in SQLite BLOBs, and the brute-force cosine ranking retrieval
// uses (spec business-bots "Retrieval", design D7).
//
// The embedding is stored as a little-endian Float32 blob plus its dimensions, so
// a scan never has to guess the layout. Everything here is pure.

/**
 * @param {Float32Array|number[]} values — a typed array (what an embedding call
 *        returns) or a plain array. `Array.isArray` alone would silently encode an
 *        empty vector for the typed-array case, which stores a zero-length BLOB and
 *        makes every chunk unretrievable.
 * @returns {Buffer} little-endian Float32 BLOB
 */
export function encodeVector(values) {
  const array = ArrayBuffer.isView(values)
    ? Float32Array.from(values)
    : Float32Array.from(Array.isArray(values) ? values : []);
  const buffer = Buffer.allocUnsafe(array.length * 4);
  for (let i = 0; i < array.length; i += 1) buffer.writeFloatLE(array[i], i * 4);
  return buffer;
}

/** @returns {Float32Array|null} null for a NULL/empty/wrong-length blob */
export function decodeVector(blob, dims = null) {
  if (!blob) return null;
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buffer.length === 0 || buffer.length % 4 !== 0) return null;
  const expected = Number.isInteger(dims) && dims > 0 ? dims * 4 : buffer.length;
  if (buffer.length !== expected) return null;
  const out = new Float32Array(buffer.length / 4);
  for (let i = 0; i < out.length; i += 1) out[i] = buffer.readFloatLE(i * 4);
  return out;
}

/** Cosine similarity of two equal-length vectors; 0 when one has no magnitude. */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Rank `items` against `query` and keep the best ones.
 *
 * @param {Float32Array|number[]} query
 * @param {Array<{ embedding: Float32Array|number[], [key:string]: any }>} items
 * @param {{ topK?: number, threshold?: number }} [options]
 * @returns {Array<{ item: object, score: number }>} score-descending, above threshold
 */
export function topK(query, items, { topK = 5, threshold = 0.3 } = {}) {
  const limit = Math.max(1, Math.floor(Number(topK) || 5));
  const floor = Number.isFinite(Number(threshold)) ? Number(threshold) : 0;
  const scored = [];
  for (const item of items ?? []) {
    if (!item?.embedding) continue;
    const score = cosine(query, item.embedding);
    if (score >= floor) scored.push({ item, score });
  }
  // Stable for equal scores: the earlier chunk wins, so a listing is repeatable.
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/** Total bytes a decoded vector costs in the LRU cache. */
export function vectorBytes(vector) {
  return vector ? vector.length * 4 : 0;
}
