/**
 * Token Usage Tracking - Extract, normalize, estimate and log token usage
 */

import { FORMATS } from "../translator/formats.js";

// Legacy per-chunk usage console line; off by default (superseded by "📊 done")
const DEBUG_USAGE = process.env.LOG_USAGE_VERBOSE === "1";

// ANSI color codes
export const COLORS = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m"
};

// Get HH:MM:SS timestamp
function getTimeString() {
  return new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * Which usage a finished request records. The upstream's own figures always win; an estimate
 * is only the fallback for an upstream that reported none. Callers keep the two apart (never
 * merge them with mergeUsage: it takes the larger of each field, so a rough estimate used to
 * beat the real numbers and drop the cached-token details).
 * @param {{ real: object|null, estimate?: () => object|null }} p
 */
export function pickRecordedUsage({ real, estimate }) {
  if (hasValidUsage(real)) return real;
  return estimate ? estimate() : null;
}

/**
 * Anthropic-style usage from an OpenAI usage object. Anthropic reports the cached part of the
 * prompt separately: input_tokens excludes it and cache_read_input_tokens /
 * cache_creation_input_tokens carry it.
 */
export function claudeUsageFromOpenAI(usage) {
  const u = usage || {};
  if (typeof u.prompt_tokens !== "number") {
    const kept = { input_tokens: u.input_tokens || 0, output_tokens: u.completion_tokens || u.output_tokens || 0 };
    if (u.cache_read_input_tokens > 0) kept.cache_read_input_tokens = u.cache_read_input_tokens;
    if (u.cache_creation_input_tokens > 0) kept.cache_creation_input_tokens = u.cache_creation_input_tokens;
    return kept;
  }
  const read = Number(u.prompt_tokens_details?.cached_tokens) || 0;
  const created = Number(u.prompt_tokens_details?.cache_creation_tokens) || 0;
  const out = {
    input_tokens: Math.max(0, u.prompt_tokens - read - created),
    output_tokens: u.completion_tokens || u.output_tokens || 0,
  };
  if (read > 0) out.cache_read_input_tokens = read;
  if (created > 0) out.cache_creation_input_tokens = created;
  return out;
}

// Client-facing: `estimated` is internal bookkeeping and is never whitelisted here.
export function filterUsageForFormat(usage, targetFormat) {
  if (!usage || typeof usage !== "object") return usage;

  // Helper to pick only defined fields from usage
  const pickFields = (fields) => {
    const filtered = {};
    for (const field of fields) {
      if (usage[field] !== undefined) {
        filtered[field] = usage[field];
      }
    }
    return filtered;
  };

  // Define allowed fields for each format
  const formatFields = {
    [FORMATS.CLAUDE]: [
      'input_tokens', 'output_tokens', 
      'cache_read_input_tokens', 'cache_creation_input_tokens'
    ],
    [FORMATS.GEMINI]: [
      'promptTokenCount', 'candidatesTokenCount', 'totalTokenCount',
      'cachedContentTokenCount', 'thoughtsTokenCount'
    ],
    [FORMATS.OPENAI_RESPONSES]: [
      'input_tokens', 'output_tokens',
      'input_tokens_details', 'output_tokens_details'
    ],
    // OpenAI format (default for OPENAI, CODEX, KIRO, etc.)
    default: [
      'prompt_tokens', 'completion_tokens', 'total_tokens',
      'cached_tokens', 'reasoning_tokens',
      'prompt_tokens_details', 'completion_tokens_details'
    ]
  };

  // Get fields for target format
  let fields = formatFields[targetFormat];
  
  // Use same fields for similar formats
  if (targetFormat === FORMATS.GEMINI_CLI || targetFormat === FORMATS.ANTIGRAVITY) {
    fields = formatFields[FORMATS.GEMINI];
  } else if (targetFormat === FORMATS.OPENAI_RESPONSE) {
    fields = formatFields[FORMATS.OPENAI_RESPONSES];
  } else if (!fields) {
    fields = formatFields.default;
  }

  return pickFields(fields);
}

/**
 * Normalize usage object - ensure all values are valid numbers
 */
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;

  const normalized = {};
  const assignNumber = (key, value) => {
    if (value === undefined || value === null) return;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) normalized[key] = numeric;
  };

  assignNumber("prompt_tokens", usage?.prompt_tokens);
  assignNumber("completion_tokens", usage?.completion_tokens);
  assignNumber("total_tokens", usage?.total_tokens);
  assignNumber("cache_read_input_tokens", usage?.cache_read_input_tokens);
  assignNumber("cache_creation_input_tokens", usage?.cache_creation_input_tokens);
  assignNumber("cached_tokens", usage?.cached_tokens);
  assignNumber("reasoning_tokens", usage?.reasoning_tokens);
  if (usage?.estimated === true) normalized.estimated = true;

  // Preserve nested details objects for OpenAI format forwarding
  if (usage?.prompt_tokens_details && typeof usage.prompt_tokens_details === "object") {
    normalized.prompt_tokens_details = usage.prompt_tokens_details;
  }
  if (usage?.completion_tokens_details && typeof usage.completion_tokens_details === "object") {
    normalized.completion_tokens_details = usage.completion_tokens_details;
  }

  if (Object.keys(normalized).length === 0) return null;
  return normalized;
}

/**
 * Canonicalize usage into ONE storage/cost convention so token counts and cost
 * are consistent across providers:
 *   prompt_tokens               = total input INCLUDING cache read + cache creation
 *   cached_tokens               = cache-read portion (subset of prompt_tokens)
 *   cache_creation_input_tokens = cache-write portion (subset of prompt_tokens)
 *   completion_tokens, reasoning_tokens, total_tokens
 *
 * Discriminator: Claude reports cache_read_input_tokens with a prompt that
 * EXCLUDES cache, so we fold cache into prompt. OpenAI/Gemini report
 * cached_tokens already counted inside prompt, so we pass through. Idempotent:
 * once folded the output carries cached_tokens (not cache_read_input_tokens),
 * so re-running takes the passthrough branch and does not double-add.
 *
 * @param {object} usage - a normalizeUsage()-shaped object
 * @returns {object|null} canonical token object, or null for invalid input
 */
export function canonicalizeUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;

  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const completion = num(usage.completion_tokens ?? usage.output_tokens);
  // Convention: reasoning_tokens is a SUBSET of completion_tokens (OpenAI, DeepSeek, Responses
  // all report it that way; the Gemini extractors fold thoughts into completion). It is
  // priced at the reasoning rate and the rest of the completion at the output rate, so it
  // can never exceed the completion it is part of.
  const reasoning = Math.min(num(usage.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens), completion);
  // Fall back to the nested prompt_tokens_details.cache_creation_tokens shape
  // (buildUsage()'s OpenAI-forwarding format) when the top-level field is
  // absent, so callers that pass a buildUsage() object through don't silently
  // drop cache_creation.
  const cacheCreation = num(usage.cache_creation_input_tokens ?? usage.prompt_tokens_details?.cache_creation_tokens);

  let prompt = num(usage.prompt_tokens ?? usage.input_tokens);
  let cached;

  // Claude path: prompt excludes cache; cache_read_input_tokens and/or
  // cache_creation_input_tokens are separate. A cache-miss "first write" only
  // carries cache_creation_input_tokens (no cache_read_input_tokens yet), so
  // check both fields — otherwise a first-write request falls through to the
  // OpenAI passthrough branch below and cache_creation never gets folded in.
  // Guard on the absence of `cached_tokens`: our own canonical output always
  // sets that key (even to 0), so re-running canonicalizeUsage on an already-
  // folded result takes the passthrough branch instead of folding again.
  if (usage.cached_tokens === undefined &&
      (usage.cache_read_input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined)) {
    cached = num(usage.cache_read_input_tokens);
    prompt = prompt + cached + cacheCreation;
  } else {
    // OpenAI/Gemini path (or already-canonical input): prompt already includes cached_tokens.
    // Mirror the cacheCreation fallback above: buildUsage() only ever emits the
    // nested prompt_tokens_details.cached_tokens shape, so without this the
    // cache-read count is silently dropped on every buildUsage()-derived usage.
    cached = num(usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens);
  }

  const result = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    // Recompute rather than pass through: when the fold branch ran above,
    // an upstream total_tokens (cache-exclusive) would otherwise be stale.
    total_tokens: prompt + completion,
    cached_tokens: cached,
    cache_creation_input_tokens: cacheCreation,
  };
  if (reasoning > 0) result.reasoning_tokens = reasoning;
  // Carried through so the usage row can say the figures are an estimate.
  if (usage.estimated === true) result.estimated = true;
  return result;
}

/**
 * Check if usage has valid token data
 * Valid = has at least one token field with value > 0
 * Invalid = empty object {}, null, undefined, no token fields, or all zeros
 */
export function hasValidUsage(usage) {
  if (!usage || typeof usage !== "object") return false;

  // Check for any known token field with value > 0
  const tokenFields = [
    "prompt_tokens", "completion_tokens", "total_tokens",  // OpenAI
    "input_tokens", "output_tokens",                        // Claude
    "promptTokenCount", "candidatesTokenCount"              // Gemini
  ];

  for (const field of tokenFields) {
    if (typeof usage[field] === "number" && usage[field] > 0) {
      return true;
    }
  }

  return false;
}

/**
 * Extract usage from any format (Claude, OpenAI, Gemini, Responses API)
 */
export function extractUsage(chunk) {
  if (!chunk || typeof chunk !== "object") return null;

  // Claude format (message_start event): carries input_tokens + cache_read +
  // cache_creation. message_delta later carries only the final output_tokens,
  // so callers must MERGE (mergeUsage), not overwrite, to keep cache counts.
  if (chunk.type === "message_start" && chunk.message?.usage && typeof chunk.message.usage === "object") {
    const u = chunk.message.usage;
    return normalizeUsage({
      prompt_tokens: u.input_tokens || 0,
      completion_tokens: u.output_tokens || 0,
      cache_read_input_tokens: u.cache_read_input_tokens,
      cache_creation_input_tokens: u.cache_creation_input_tokens
    });
  }

  // Claude format (message_delta event)
  if (chunk.type === "message_delta" && chunk.usage && typeof chunk.usage === "object") {
    return normalizeUsage({
      prompt_tokens: chunk.usage.input_tokens || 0,
      completion_tokens: chunk.usage.output_tokens || 0,
      cache_read_input_tokens: chunk.usage.cache_read_input_tokens,
      cache_creation_input_tokens: chunk.usage.cache_creation_input_tokens
    });
  }

  // OpenAI Responses API format (response.completed or response.done)
  if ((chunk.type === "response.completed" || chunk.type === "response.done" || chunk.type === "response.incomplete" || chunk.type === "response.failed") && chunk.response?.usage && typeof chunk.response.usage === "object") {
    const usage = chunk.response.usage;
    const cachedTokens = usage.input_tokens_details?.cached_tokens;
    return normalizeUsage({
      prompt_tokens: usage.input_tokens || usage.prompt_tokens || 0,
      completion_tokens: usage.output_tokens || usage.completion_tokens || 0,
      cached_tokens: cachedTokens,
      reasoning_tokens: usage.output_tokens_details?.reasoning_tokens,
      prompt_tokens_details: cachedTokens ? { cached_tokens: cachedTokens } : undefined
    });
  }

  // OpenAI format (also covers DeepSeek which uses prompt_cache_hit_tokens)
  if (chunk.usage && typeof chunk.usage === "object" && chunk.usage.prompt_tokens !== undefined) {
    return normalizeUsage({
      prompt_tokens: chunk.usage.prompt_tokens,
      completion_tokens: chunk.usage.completion_tokens || 0,
      cached_tokens: chunk.usage.prompt_tokens_details?.cached_tokens || chunk.usage.prompt_cache_hit_tokens || chunk.usage.cached_tokens,
      reasoning_tokens: chunk.usage.completion_tokens_details?.reasoning_tokens,
      prompt_tokens_details: chunk.usage.prompt_tokens_details,
      completion_tokens_details: chunk.usage.completion_tokens_details
    });
  }

  // Gemini format (Antigravity)
  // Antigravity wraps usageMetadata inside response: { response: { usageMetadata: {...} } }
  const usageMeta = chunk.usageMetadata || chunk.response?.usageMetadata;
  if (usageMeta && typeof usageMeta === "object") {
    return normalizeUsage({
      prompt_tokens: usageMeta.promptTokenCount || 0,
      // Gemini reports thinking tokens apart from the candidates; they are output, billed as
      // such, so completion_tokens carries both and reasoning_tokens stays the subset.
      completion_tokens: (usageMeta.candidatesTokenCount || 0) + (usageMeta.thoughtsTokenCount || 0),
      total_tokens: usageMeta.totalTokenCount,
      cached_tokens: usageMeta.cachedContentTokenCount,
      reasoning_tokens: usageMeta.thoughtsTokenCount
    });
  }

  // Ollama NDJSON format (raw from provider, before translation)
  // Ollama sends: {"model":"...","done":true,"prompt_eval_count":N,"eval_count":M}
  if (chunk.done === true && typeof chunk.prompt_eval_count === "number") {
    return normalizeUsage({
      prompt_tokens: chunk.prompt_eval_count || 0,
      completion_tokens: chunk.eval_count || 0,
      total_tokens: (chunk.prompt_eval_count || 0) + (chunk.eval_count || 0)
    });
  }

  return null;
}

// Field-wise max-merge of two usage objects. Anthropic splits usage across
// events: message_start has real input+cache (output is a placeholder 1),
// message_delta has the real cumulative output (input/cache absent). Max keeps
// the meaningful value from each without clobbering. Idempotent for other
// providers that emit a single complete usage object.
export function mergeUsage(prev, next) {
  if (!prev) return next || null;
  if (!next) return prev;
  const merged = { ...prev };
  // `estimated` survives a merge only when every part was estimated: real figures win.
  if (next.estimated !== true) delete merged.estimated;
  for (const [k, v] of Object.entries(next)) {
    // typeof NaN === "number" — guard with Number.isFinite so one malformed
    // chunk can't poison the whole accumulation (Math.max(x, NaN) is NaN).
    if (typeof v === "number" && Number.isFinite(v)) {
      merged[k] = Math.max(typeof merged[k] === "number" ? merged[k] : 0, v);
    } else if (v && typeof v === "object") {
      merged[k] = v; // nested details objects: take latest
    }
  }
  return merged;
}

// ── Estimation ─────────────────────────────────────────────────────────────
// An estimate is a BILLING fallback for an upstream that reported no usage at all. It is
// never shown to a client, never carries a safety margin ("buffer"), and is always flagged
// `estimated: true` so the usage row can say so. No tokenizer is bundled (package.json has
// none and none may be added), so this is a heuristic and is documented as such in spec
// usage-accuracy: expect it to be off by tens of percent, never exact.
//
// Heuristic: English-like ASCII text is ~4 characters per token; non-ASCII text (CJK,
// Vietnamese diacritics, emoji) is denser, ~2 characters per token. Base64 payloads
// (inline images, files) are not text and are counted as a flat per-item cost instead of
// by their encoded length, which used to inflate a single screenshot into ~100k tokens.
const ASCII_CHARS_PER_TOKEN = 4;
const WIDE_CHARS_PER_TOKEN = 2;
const MEDIA_ITEM_TOKENS = 1000;
// Keys whose value is a JSON document the model reads as text (tool schemas): count it whole.
const JSON_TEXT_KEYS = new Set(["tools", "functions", "tool_choice", "response_format", "toolConfig", "tool_config"]);
// Keys that carry opaque or binary data and never reach the model as text.
const OPAQUE_KEYS = new Set(["signature", "encrypted_content", "reasoning_encrypted_content", "thoughtSignature"]);
// Structural keys whose short string values are protocol framing, not prompt text.
const STRUCTURAL_KEYS = new Set(["role", "type", "model", "id", "object", "tool_call_id", "tool_use_id", "media_type", "mime_type", "mimeType"]);

function isBase64Payload(key, value) {
  if (typeof value !== "string") return false;
  if (value.startsWith("data:") && value.includes(";base64,")) return true;
  return key === "data" && value.length > 256 && /^[A-Za-z0-9+/=\s]+$/.test(value.slice(0, 256));
}

/** Count text characters (split into ASCII / wide) and media items in a request body. */
function measureBody(node, key, acc, depth = 0) {
  if (node === null || node === undefined || depth > 40) return;
  if (typeof node === "string") {
    if (OPAQUE_KEYS.has(key) || STRUCTURAL_KEYS.has(key)) return;
    if (isBase64Payload(key, node)) { acc.media += 1; return; }
    for (let i = 0; i < node.length; i++) {
      if (node.charCodeAt(i) < 128) acc.ascii++; else acc.wide++;
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) measureBody(item, key, acc, depth + 1);
    return;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (JSON_TEXT_KEYS.has(k)) {
        try { measureBody(JSON.stringify(v), k, acc, depth + 1); } catch { /* unserialisable: skip */ }
      } else {
        measureBody(v, k, acc, depth + 1);
      }
    }
  }
}

function charsToTokens({ ascii = 0, wide = 0 }) {
  return Math.ceil(ascii / ASCII_CHARS_PER_TOKEN + wide / WIDE_CHARS_PER_TOKEN);
}

/**
 * Estimate input tokens from the request body (text only; see the heuristic above).
 */
export function estimateInputTokens(body) {
  if (!body || typeof body !== "object") return 0;
  try {
    const acc = { ascii: 0, wide: 0, media: 0 };
    measureBody(body, "", acc);
    return charsToTokens(acc) + acc.media * MEDIA_ITEM_TOKENS;
  } catch {
    return 0;
  }
}

/**
 * Estimate output tokens from generated text. Accepts the text itself, a
 * { ascii, wide } character count, or a plain character count (treated as ASCII).
 */
export function estimateOutputTokens(content) {
  let stats;
  if (typeof content === "string") {
    stats = { ascii: 0, wide: 0 };
    for (let i = 0; i < content.length; i++) {
      if (content.charCodeAt(i) < 128) stats.ascii++; else stats.wide++;
    }
  } else if (content && typeof content === "object") {
    stats = content;
  } else {
    stats = { ascii: Number(content) > 0 ? Number(content) : 0, wide: 0 };
  }
  if (!(stats.ascii > 0) && !(stats.wide > 0)) return 0;
  return Math.max(1, charsToTokens(stats));
}

/**
 * Format an estimated usage object for a target format. Always flagged `estimated`.
 * No safety margin is added: the figures are the estimate itself.
 * @param {number} inputTokens - Input/prompt tokens
 * @param {number} outputTokens - Output/completion tokens
 * @param {string} targetFormat - Target format from FORMATS
 */
export function formatUsage(inputTokens, outputTokens, targetFormat) {
  if (targetFormat === FORMATS.CLAUDE) {
    return { input_tokens: inputTokens, output_tokens: outputTokens, estimated: true };
  }
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    estimated: true,
  };
}

/**
 * Estimate full usage when the provider reported none (billing fallback only).
 * @param {object} body - Request body for input token estimation
 * @param {number|object|string} content - Generated text, or its length / { ascii, wide } counts
 * @param {string} targetFormat - Target format from FORMATS constant
 */
export function estimateUsage(body, content, targetFormat = FORMATS.OPENAI) {
  return formatUsage(
    estimateInputTokens(body),
    estimateOutputTokens(content),
    targetFormat
  );
}

/**
 * Log usage with cache info (green color)
 */
export function logUsage(provider, usage, model = null, connectionId = null, apiKey = null) {
  if (!usage || typeof usage !== "object") return;

  // Console output moved to the unified "📊 done" line (streamingHandler). Kept as
  // a no-op hook so callers stay unchanged; usage persistence happens via saveUsageStats.
  if (!DEBUG_USAGE) return;

  const p = provider?.toUpperCase() || "UNKNOWN";

  // Support both formats:
  // - OpenAI: prompt_tokens, completion_tokens
  // - Claude: input_tokens, output_tokens
  const inTokens = usage?.prompt_tokens || usage?.input_tokens || 0;
  const outTokens = usage?.completion_tokens || usage?.output_tokens || 0;
  const accountPrefix = connectionId ? connectionId.slice(0, 8) + "..." : "unknown";

  let msg = `[${getTimeString()}] 📊 ${COLORS.green}[USAGE] ${p} | in=${inTokens} | out=${outTokens} | account=${accountPrefix}${COLORS.reset}`;

  // Add estimated flag if present
  if (usage.estimated) {
    msg += ` ${COLORS.yellow}(estimated)${COLORS.reset}`;
  }

  // Add cache info if present (unified from different formats)
  const cacheRead = usage.cache_read_input_tokens || usage.cached_tokens || usage.prompt_tokens_details?.cached_tokens;
  if (cacheRead) msg += ` | cache_read=${cacheRead}`;

  const cacheCreation = usage.cache_creation_input_tokens;
  if (cacheCreation) msg += ` | cache_create=${cacheCreation}`;

  const reasoning = usage.reasoning_tokens;
  if (reasoning) msg += ` | reasoning=${reasoning}`;

  console.log(msg);
}
