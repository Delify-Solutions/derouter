/**
 * Estimated cached-prompt tokens for requests whose upstream reports no usage (spec
 * usage-accuracy, "Estimated cache"). Pure JS, no tokenizer, no flat ratio.
 *
 * Idea: a provider's prefix cache reuses the longest prompt prefix it has seen recently. The
 * router remembers, per scope (tenant key, upstream connection, upstream model), the last few
 * prompt texts it sent, and for a new request measures how much of the text it shares with them.
 * That shared fraction of the request's own estimated prompt tokens, rounded DOWN to the
 * provider's block size, is the estimated cache hit. It is an estimate: an expired upstream
 * cache, a different TTL or a different block size makes it wrong, and it is labelled as such.
 *
 * It only ever runs on the ESTIMATED path (the upstream reported no usable usage), after the
 * response has been delivered; it never touches bytes in flight.
 *
 * Relative imports only (loaded directly by `node --test`).
 */
import { createHash } from "node:crypto";

/** A positive finite number from an env string, else the default (junk, 0 and negatives are ignored). */
export function positiveNumber(raw, fallback) {
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
}

export const CACHE_BLOCK_TOKENS = 64;               // boltz reports cached_tokens in multiples of 64
export const CACHE_TTL_MS = positiveNumber(process.env.CACHE_ESTIMATION_TTL_MS, 10 * 60 * 1000);
// Caps are in BYTES of stored text (UTF-16, 2 bytes per character: what the process really holds).
export const CACHE_MAX_TOTAL_BYTES = positiveNumber(process.env.CACHE_ESTIMATION_MAX_BYTES, 64 * 1024 * 1024);
export const CACHE_MAX_ENTRY_BYTES = positiveNumber(process.env.CACHE_ESTIMATION_ENTRY_MAX_BYTES, 8 * 1024 * 1024);
export const TEXTS_PER_SCOPE = 3;
// How often (at most) remember()/estimateCachedTokens() sweep out scopes whose newest text is past
// the TTL, so memory is released without waiting for a read of that scope.
export const SWEEP_INTERVAL_MS = 30 * 1000;

const asBuffer = (x) => (Buffer.isBuffer(x) ? x : Buffer.from(String(x), "utf16le"));

/**
 * Length in BYTES of the common prefix of two buffers. Native block compares skip the long
 * equal run (about 0.1 ms per MB), then a byte loop finds the exact end of the last block.
 */
function commonPrefixBytes(A, B) {
  const n = Math.min(A.length, B.length);
  const BLOCK = 8192;
  let i = 0;
  while (i + BLOCK <= n && A.compare(B, i, i + BLOCK, i, i + BLOCK) === 0) i += BLOCK;
  while (i < n && A[i] === B[i]) i++;
  return i;
}

/** Length (UTF-16 code units) of the common prefix of two strings. */
export function commonPrefixLength(a, b) {
  if (!a || !b) return 0;
  return Math.floor(commonPrefixBytes(asBuffer(a), asBuffer(b)) / 2);
}

// Inline binary payloads (images, files) are base64 text of arbitrary size. They are not prompt
// text, and keeping them would inflate memory and the shared-character ratio, so each is replaced
// by a short stable token (hash + length): the same image gives the same token, a different one
// does not. The token is far shorter than the media's real token cost, so a matching image makes
// the estimate conservative (it counts less cache than the provider probably reuses).
const B64_DATA_URI = /data:[A-Za-z0-9.+\/-]{1,60};base64,[A-Za-z0-9+\/=]{128,}/g;
const B64_JSON_FIELD = /("data":")[A-Za-z0-9+\/=]{256,}(")/g;
const shortHash = (str) => createHash("sha1").update(str).digest("hex").slice(0, 12);
export function shrinkBinaryPayloads(text) {
  if (!text.includes("base64") && !text.includes('"data":"')) return text;
  return text
    .replace(B64_DATA_URI, (m) => `${m.slice(0, m.indexOf(",") + 1)}#${shortHash(m)}:${m.length}`)
    .replace(B64_JSON_FIELD, (m, a, b) => `${a}#${shortHash(m)}:${m.length}${b}`);
}

/**
 * Text of a request as the provider renders it, in render order: instructions/system, tools,
 * then the conversation, each message serialised on its own so that appending a turn leaves the
 * earlier text byte-identical. Works for OpenAI chat, Anthropic, Responses and Gemini bodies.
 */
export function promptTextForCache(body) {
  if (!body || typeof body !== "object") return "";
  const parts = [];
  const add = (label, value) => {
    if (value === undefined || value === null) return;
    try { parts.push(label + (typeof value === "string" ? value : JSON.stringify(value))); } catch { /* skip */ }
  };
  add("S:", body.system);
  add("I:", body.instructions);
  add("SI:", body.systemInstruction ?? body.system_instruction);
  add("T:", body.tools);
  const list = Array.isArray(body.messages) ? body.messages
    : Array.isArray(body.input) ? body.input
    : Array.isArray(body.contents) ? body.contents : null;
  if (list) {
    for (const item of list) add("M:", item);
  } else {
    add("M:", body.input ?? body.prompt);
  }
  return shrinkBinaryPayloads(parts.join("\n"));
}

/** One bounded LRU store. A module-level default instance backs the router; tests make their own. */
export function createCacheEstimator({
  ttlMs = CACHE_TTL_MS,
  maxTotalBytes = CACHE_MAX_TOTAL_BYTES,
  maxEntryBytes = CACHE_MAX_ENTRY_BYTES,
  sweepIntervalMs = SWEEP_INTERVAL_MS,
  now = Date.now,
} = {}) {
  /** @type {Map<string, { texts: { buf: Buffer, at: number }[], bytes: number }>} least recently used first */
  const scopes = new Map();
  let totalBytes = 0;

  const dropScope = (key) => {
    const s = scopes.get(key);
    if (!s) return;
    totalBytes -= s.bytes;
    scopes.delete(key);
  };
  const sumBytes = (texts) => texts.reduce((n, e) => n + e.buf.length, 0);

  // Lazy sweep: at most once per sweepIntervalMs, drop every scope whose NEWEST text is past the
  // TTL (expiry on read alone never frees the memory of a scope nobody asks about again).
  let lastSweep = now();
  const sweep = (t) => {
    if (t - lastSweep < sweepIntervalMs) return;
    lastSweep = t;
    for (const [key, s] of scopes) {
      const newest = s.texts.length ? s.texts[s.texts.length - 1].at : 0;
      if (t - newest > ttlMs) dropScope(key);
    }
  };

  return {
    /**
     * Longest common prefix (UTF-16 code units) between `text` and any remembered text of the
     * scope. Stores nothing and does not refresh recency.
     */
    commonChars(scope, text) {
      const s = scopes.get(scope);
      if (!s || !text) return 0;
      const buf = asBuffer(text);
      const t = now();
      let best = 0; // bytes
      for (const e of s.texts) {
        if (t - e.at > ttlMs) continue;
        if (e.buf.length <= best) continue; // cannot beat the best so far
        const c = commonPrefixBytes(e.buf, buf);
        if (c > best) best = c;
        if (best === buf.length) break;
      }
      return Math.floor(best / 2);
    },

    /** Remember the text of a request (last TEXTS_PER_SCOPE per scope); false if ignored. */
    remember(scope, text) {
      if (!text) return false;
      const buf = asBuffer(text);
      if (buf.length > maxEntryBytes) return false;
      const t = now();
      sweep(t);
      let s = scopes.get(scope);
      if (s) { scopes.delete(scope); totalBytes -= s.bytes; } // re-inserted below: most recently used
      else s = { texts: [], bytes: 0 };
      // Drop expired texts, and texts that are a prefix of the new one (or identical): the new
      // text matches any later request at least as far as they would, so keeping them only
      // costs memory.
      s.texts = s.texts.filter((e) => t - e.at <= ttlMs && !(e.buf.length <= buf.length && commonPrefixBytes(e.buf, buf) === e.buf.length));
      s.texts.push({ buf, at: t });
      while (s.texts.length > TEXTS_PER_SCOPE) s.texts.shift(); // replace the oldest
      s.bytes = sumBytes(s.texts);
      scopes.set(scope, s);
      totalBytes += s.bytes;
      // Evict least recently used scopes until under the cap (the one just written is last).
      while (totalBytes > maxTotalBytes && scopes.size > 1) {
        dropScope(scopes.keys().next().value);
      }
      // Conflicting caps: shrink the scope itself (oldest text first), dropping it if need be.
      while (totalBytes > maxTotalBytes && s.texts.length > 1) {
        const old = s.texts.shift();
        s.bytes -= old.buf.length;
        totalBytes -= old.buf.length;
      }
      if (totalBytes > maxTotalBytes) { dropScope(scope); return false; }
      return true;
    },

    /**
     * Estimated cached prompt tokens: the shared fraction of `promptTokens`, rounded down to a
     * block, kept below the prompt itself. 0 when nothing is shared.
     */
    estimateCachedTokens(scope, text, promptTokens) {
      if (!text || !(promptTokens > 0)) return 0;
      const buf = asBuffer(text);
      sweep(now());
      const common = this.commonChars(scope, buf);
      if (common <= 0) return 0;
      const prefixTokens = promptTokens * (common / (buf.length / 2));
      const capped = Math.min(prefixTokens, promptTokens - 1);
      return Math.max(0, Math.floor(capped / CACHE_BLOCK_TOKENS) * CACHE_BLOCK_TOKENS);
    },

    stats() { return { scopes: scopes.size, bytes: totalBytes }; },
    clear() { scopes.clear(); totalBytes = 0; },
  };
}

const defaultEstimator = createCacheEstimator();

/** Scope per tenant key + upstream connection + upstream model. The key is hashed in memory. */
export function cacheScope(apiKey, connectionId, model) {
  const k = apiKey ? createHash("sha1").update(String(apiKey)).digest("hex").slice(0, 16) : "anon";
  return `${k}|${connectionId || ""}|${model || ""}`;
}

/**
 * The context chatCore hands to the handlers: null (feature off for this request) unless the combo
 * option is on AND the request has an API key, since the remembered prompts are scoped to a tenant.
 */
export function makeCacheCtx({ enabled, apiKey, connectionId, model, getText }) {
  if (enabled !== true || !apiKey) return null;
  return { scope: cacheScope(apiKey, connectionId, model), getText };
}

/**
 * Apply the estimate to a recorded usage and remember the request's prompt.
 *
 * `ctx` = { scope, getText() } from chatCore (null when the combo has the feature off).
 * The usage is changed only when it is a pure estimate (`estimated: true`): real upstream usage,
 * with or without cache details, is returned untouched. The prompt is remembered either way,
 * so a later estimated request can find it, except when the request recorded nothing.
 *
 * @param {object|null} usage - usage about to be recorded
 * @param {{ scope: string, getText: () => string }|null} ctx
 * @param {ReturnType<typeof createCacheEstimator>} [estimator]
 * @returns {object|null} usage (a copy with prompt_tokens_details.cached_tokens when estimated)
 */
export function applyEstimatedCache(usage, ctx, estimator = defaultEstimator) {
  if (!ctx || !usage || typeof usage !== "object") return usage;
  try {
    let text = ctx.getText();
    if (!text) return usage;
    text = asBuffer(text); // converted once; compared and stored as bytes
    let out = usage;
    if (usage.estimated === true) {
      const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
      const cached = estimator.estimateCachedTokens(ctx.scope, text, promptTokens);
      out = { ...usage, cache_estimated: true, prompt_tokens_details: { ...(usage.prompt_tokens_details || {}), cached_tokens: cached } };
    }
    estimator.remember(ctx.scope, text);
    return out;
  } catch {
    // An estimate must never break recording: fall back to the usage exactly as it was.
    return usage;
  }
}

export { defaultEstimator };
