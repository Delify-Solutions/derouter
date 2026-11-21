// Text chunking for the knowledge base (spec business-bots "Chunking").
//
// Pure and dependency-free so it can be unit-tested under plain `node --test`.
//
//   file/text documents → paragraph split, ≤1000 characters per chunk, consecutive
//                         chunks sharing the last 200 characters of the previous;
//   qa pairs            → one chunk per pair, "Hỏi: …\nĐáp: …".
//
// The overlap is a literal slice of the previous chunk: a chunk always BEGINS with
// exactly the tail of its predecessor, which is what retrieval needs to see a
// sentence that was cut in two halves.

export const CHUNK_MAX_CHARS = 1000;
export const CHUNK_OVERLAP_CHARS = 200;
export const QA_PAIR_MAX_CHARS = 2000;
export const QA_PAIR_MAX_COUNT = 500;

/** Collapse the whitespace that survives extraction, keeping paragraph breaks. */
function normalize(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitSentences(paragraph) {
  // Keep the punctuation with its sentence; Vietnamese texts use "." and "!" —
  // also break on "?" and "…" — and a hard newline always ends a unit.
  const units = paragraph
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?…])\s+/))
    .map((unit) => unit.trim())
    .filter(Boolean);
  return units;
}

/** Split a unit longer than `limit` at whitespace boundaries (fallback: hard cut). */
function hardSplit(unit, limit) {
  const out = [];
  let rest = unit;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf(" ", limit);
    if (cut < Math.floor(limit / 2)) cut = limit;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/**
 * Paragraph pieces, each at most `budget` characters, ordered as in the source.
 * A paragraph is kept whole while it fits; a long one is split at sentence
 * boundaries, and a single sentence longer than the budget at whitespace.
 */
function piecesOf(text, budget) {
  const paragraphs = normalize(text).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const pieces = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= budget) {
      pieces.push(paragraph);
      continue;
    }
    const units = splitSentences(paragraph);
    let current = "";
    for (const unit of units) {
      const parts = unit.length > budget ? hardSplit(unit, budget) : [unit];
      for (const part of parts) {
        const joined = current ? `${current} ${part}` : part;
        if (joined.length <= budget) {
          current = joined;
        } else {
          if (current) pieces.push(current);
          current = part;
        }
      }
    }
    if (current) pieces.push(current);
  }
  return pieces;
}

/**
 * Chunk one document's text.
 *
 * @param {string} text
 * @param {{ maxChars?: number, overlap?: number }} [options]
 * @returns {string[]} non-empty chunks, each ≤ maxChars, each (after the first)
 *          starting with the last `overlap` characters of its predecessor.
 */
export function chunkText(text, { maxChars = CHUNK_MAX_CHARS, overlap = CHUNK_OVERLAP_CHARS } = {}) {
  const max = Math.max(1, Math.floor(Number(maxChars) || CHUNK_MAX_CHARS));
  const cut = Math.min(Math.max(0, Math.floor(Number(overlap) || 0)), Math.floor(max / 2));
  // Each emitted chunk is `tail + " " + new content`, so the new content may use
  // max − cut − 1 characters and the result still fits in `max`.
  const budget = Math.max(1, max - cut - (cut > 0 ? 1 : 0));

  const chunks = [];
  let buffer = "";
  const flush = () => {
    if (!buffer) return;
    const previous = chunks[chunks.length - 1];
    const tail = previous && cut > 0 ? previous.slice(Math.max(0, previous.length - cut)) : "";
    const chunk = tail ? `${tail}\n${buffer}` : buffer;
    chunks.push(chunk.length > max ? chunk.slice(chunk.length - max) : chunk);
    buffer = "";
  };

  for (const piece of piecesOf(text, budget)) {
    if (!buffer) {
      buffer = piece;
      continue;
    }
    if (`${buffer} ${piece}`.length <= budget) {
      buffer = `${buffer} ${piece}`;
    } else {
      flush();
      buffer = piece;
    }
  }
  flush();
  return chunks.filter((chunk) => chunk.trim().length > 0);
}

/**
 * One chunk per question/answer pair (spec "Chunking").
 *
 * @param {Array<{question:string, answer:string}>} pairs
 * @returns {{ chunks:string[] } | { error:string }} `error` is the Vietnamese 400 text.
 */
export function qaChunks(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) return { error: "Cần ít nhất một cặp hỏi đáp" };
  if (pairs.length > QA_PAIR_MAX_COUNT) {
    return { error: `Mỗi tài liệu hỏi đáp tối đa ${QA_PAIR_MAX_COUNT} cặp` };
  }
  const chunks = [];
  for (const [index, pair] of pairs.entries()) {
    const question = typeof pair?.question === "string" ? pair.question.trim() : "";
    const answer = typeof pair?.answer === "string" ? pair.answer.trim() : "";
    if (!question || !answer) return { error: `Cặp hỏi đáp ${index + 1} cần đủ câu hỏi và câu trả lời` };
    const text = `Hỏi: ${question}\nĐáp: ${answer}`;
    if (text.length > QA_PAIR_MAX_CHARS) {
      return { error: `Cặp hỏi đáp ${index + 1} vượt quá ${QA_PAIR_MAX_CHARS} ký tự` };
    }
    chunks.push(text);
  }
  return { chunks };
}

/** UTF-8 byte length, the unit every knowledge-base quota is counted in. */
export function utf8Bytes(text) {
  return new TextEncoder().encode(String(text ?? "")).length;
}
