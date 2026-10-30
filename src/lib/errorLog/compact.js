// Shrinks a request body so it can be kept next to an error, and scrubs secrets.
//
// The point of an error log is to see what was sent, so structure (roles, tool
// calls, parameters) is kept whole and only the bulk is cut: long strings lose
// their middle, inline images become a placeholder, and a very long history keeps
// its first and last turns. Pure functions, relative imports only (tests run under
// plain `node --test`).

const REDACTED = "[redacted]";

// Replacements applied to every string that reaches the log. Heuristics, not a
// guarantee: a secret that matches none of these shapes is stored as written.
const SECRET_PATTERNS = [
  [/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, `Bearer ${REDACTED}`],
  [/\b(sk|ak|pk|rk)([-_][A-Za-z0-9]+)*[-_][A-Za-z0-9_-]{16,}/g, `$1-${REDACTED}`],
  // Vendor shapes: Google API keys and OAuth tokens, Groq, GitHub, xAI, Slack, JWTs.
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  [/\bya29\.[0-9A-Za-z._-]{20,}/g, REDACTED],
  [/\b(gsk|ghp|gho|ghs|ghu|xai|xoxb|xoxp)[-_][A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, REDACTED],
  [/([?&](?:key|api[_-]?key|access[_-]?token|token)=)[^&\s"'<>]+/gi, `$1${REDACTED}`],
  [/("(?:api[_-]?key|authorization|x-api-key|x-goog-api-key|password|secret|client_secret|private_key|access[_-]?token|refresh[_-]?token|auth_token|api_token)"\s*:\s*")[^"]*(")/gi, `$1${REDACTED}$2`],
  [/\b(x-api-key|x-goog-api-key)\s*:\s*[^\s"',]+/gi, `$1: ${REDACTED}`],
];

// Object keys whose string value is a credential whatever it looks like.
const SECRET_KEY = /^(api[_-]?key|authorization|x-api-key|x-goog-api-key|password|secret|client_secret|private_key|access[_-]?token|refresh[_-]?token|auth_token|api_token)$/i;

export function maskSecrets(text) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  for (const [re, to] of SECRET_PATTERNS) out = out.replace(re, to);
  return out;
}

const DATA_URI = /^data:([^;,]+)(?:;[^,]*)?,/;
const MAX_DEPTH = 24;
// First turns are the system prompt and the task, last turns are what failed.
const KEEP_HEAD_TURNS = 8;
const KEEP_TAIL_TURNS = 40;
// A secret straddling the cut would be half-masked; masking a little beyond each kept end covers it.
const CUT_MARGIN = 96;
// Past this the body is not walked at all: scanning it would stall the event loop for nothing.
export const MAX_COMPACT_INPUT_BYTES = 8 * 1024 * 1024;

function shrinkString(s, limit) {
  const uri = DATA_URI.exec(s);
  if (uri && s.length > 256) return `[data:${uri[1]}, ${s.length} chars]`;
  if (s.length <= limit) return maskSecrets(s);
  // Cut first, then mask only what is kept: a multi-megabyte string is never scanned whole.
  const head = Math.ceil(limit * 0.7);
  const tail = Math.max(0, limit - head);
  const kept = maskSecrets(s.slice(0, head + CUT_MARGIN)).slice(0, head);
  const end = tail ? maskSecrets(s.slice(-(tail + CUT_MARGIN))).slice(-tail) : "";
  return `${kept}\n…[${s.length - head - tail} chars cut]…\n${end}`;
}

function shrink(value, limit, depth) {
  if (typeof value === "string") return shrinkString(value, limit);
  if (value == null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[nested too deep]";
  if (Array.isArray(value)) return value.map((v) => shrink(v, limit, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = typeof v === "string" && SECRET_KEY.test(k) ? REDACTED : shrink(v, limit, depth + 1);
  }
  return out;
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null));
}

// Chat turns live under a different key per API (messages, input, contents).
const TURN_KEYS = ["messages", "input", "contents"];

function dropMiddleTurns(body) {
  const out = { ...body };
  for (const key of TURN_KEYS) {
    const turns = out[key];
    if (Array.isArray(turns) && turns.length > KEEP_HEAD_TURNS + KEEP_TAIL_TURNS) {
      const omitted = turns.length - KEEP_HEAD_TURNS - KEEP_TAIL_TURNS;
      out[key] = [
        ...turns.slice(0, KEEP_HEAD_TURNS),
        { _omitted: `${omitted} turns` },
        ...turns.slice(-KEEP_TAIL_TURNS),
      ];
    }
  }
  return out;
}

/**
 * @param {unknown} body request body exactly as the client sent it
 * @param {{ maxBytes?: number, stringLimits?: number[], originalBytes?: number }} [opts]
 *   originalBytes: the body's size when the caller already knows it (saves a serialisation)
 * @returns {{ value: unknown, truncated: boolean, originalBytes: number }}
 */
export function compactBody(body, { maxBytes = 64 * 1024, stringLimits = [8000, 2000, 500, 120], originalBytes: known } = {}) {
  const originalBytes = known ?? byteLength(body);
  if (body == null || typeof body !== "object") {
    return { value: shrink(body, stringLimits[0], 0), truncated: false, originalBytes };
  }
  const summary = (why) => ({
    value: { _omitted: `${why} (${originalBytes} bytes)`, model: typeof body.model === "string" ? body.model : undefined, stream: body.stream === true ? true : undefined },
    truncated: true,
    originalBytes,
  });
  if (originalBytes > MAX_COMPACT_INPUT_BYTES) return summary("body too large to keep");

  let value = shrink(body, stringLimits[0], 0);
  let size = byteLength(value);
  let truncated = size < originalBytes;
  for (let i = 1; size > maxBytes && i < stringLimits.length; i++) {
    value = shrink(body, stringLimits[i], 0);
    size = byteLength(value);
    truncated = true;
  }
  if (size > maxBytes) {
    value = dropMiddleTurns(value);
    truncated = true;
    // Numeric arrays, tool schemas and embedding inputs never shrink: last resort keeps the facts.
    if (byteLength(value) > maxBytes) return summary("does not fit the per-entry limit");
  }
  return { value, truncated, originalBytes };
}

// Text of the turn that likely triggered the call, for list previews.
function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === "string" ? p : p?.text ?? p?.content ?? "")).filter(Boolean).join(" ");
  }
  return "";
}

/**
 * Facts about the request that stay useful when the body itself is not stored.
 */
export function describeBody(body, bytes) {
  if (body == null || typeof body !== "object") {
    return { bodyBytes: 0, estTokens: 0, messageCount: 0, stream: false, preview: "" };
  }
  const bodyBytes = bytes ?? byteLength(body);
  let turns = [];
  for (const key of TURN_KEYS) {
    if (Array.isArray(body[key])) { turns = body[key]; break; }
  }
  if (!turns.length && typeof body.prompt === "string") turns = [{ role: "user", content: body.prompt }];
  if (!turns.length && typeof body.input === "string") turns = [{ role: "user", content: body.input }];

  let last = "";
  for (let i = turns.length - 1; i >= 0 && !last; i--) {
    const t = turns[i];
    const text = textOf(t?.content ?? t?.parts?.map?.((p) => p?.text).join(" "));
    if (t?.role === "user" || t?.role === undefined) last = text;
  }
  return {
    bodyBytes,
    // Same bytes/4 estimate the proxy uses when an upstream reports no usage.
    estTokens: Math.round(bodyBytes / 4),
    messageCount: turns.length,
    stream: body.stream === true,
    // Only the head is looked at: a preview is 200 characters, whatever the turn's size.
    preview: maskSecrets(String(last).slice(0, 400)).replace(/\s+/g, " ").trim().slice(0, 200),
  };
}
