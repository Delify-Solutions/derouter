// What a customer sees of the model that served them (spec model-privacy).
//
// Customers buy combos ("glm-5"); the upstream model behind a combo
// ("glm-5.3:pre") is the operator's business. The engine forwards the upstream
// response, whose `model` field — and some error texts — name that upstream
// model. For a customer key the response is rewritten at the very end:
//
//   - the model fields of every JSON body and every SSE `data:` event are set to
//     the name the customer asked for: `model` (OpenAI chat/chunks, Claude
//     message), `message.model` (Claude message_start), `response.model`
//     (Responses API events), `modelVersion` (Gemini);
//   - error messages have every hidden id (combo members, the upstream ids
//     actually used) replaced by that name.
//
// Message CONTENT is never touched: only those named fields and error texts.
//
// Errors (status >= 400) are rebuilt for a customer key: a denial the router
// itself decided (marked with PLATFORM_ERROR_HEADER) keeps its message; an error
// that came from an upstream is reduced to `{ error: { message, type, code } }`
// with a message that names neither the provider nor the upstream model:
//   - a problem with the request (400, 404, 413, 422): the upstream text without
//     its "[provider/model] [status]:" prefixes, URLs or hidden ids;
//   - anything about the provider side (401-403, 407, 408, 429, 5xx): a fixed
//     Vietnamese sentence. Retry-After and the status are kept.
//
// Pure and driver-free (no database): the caller works out the public name and
// the hidden ids. Relative imports only.
import { PLATFORM_ERROR_HEADER } from "../auth/platformError.js";
// The engine's own list of "request too large" texts: one source of truth.
import { REQUEST_ERROR_RULES } from "../../../open-sse/config/errorConfig.js";

/** Ids shorter than this are never scrubbed from text: too likely to be ordinary words. */
const MIN_ID_LENGTH = 3;

/**
 * Every string that identifies an upstream model: each combo member
 * ("provider/model") and its bare model part, plus the upstream ids the engine
 * reported using. The public name itself is excluded. Longest first, so
 * "zai/glm-5.3:pre" is replaced before "glm-5.3:pre".
 */
export function hiddenModelIds({ members = [], upstream = [], publicName = "" } = {}) {
  const ids = new Set();
  const add = (value) => {
    const text = typeof value === "string" ? value.trim() : "";
    // The model part of what the customer typed is not hidden from them
    // ("openai/text-embedding-3-small" names "text-embedding-3-small").
    if (text.length < MIN_ID_LENGTH || text === publicName || String(publicName).endsWith(`/${text}`)) return;
    // A bare id that looks like an ordinary word ("auto" of "openrouter/auto")
    // would rewrite prose; real model ids carry a digit or a separator.
    if (!text.includes("/") && !/[\d\-:.]/.test(text)) return;
    ids.add(text);
  };
  for (const member of members) {
    add(member);
    if (typeof member === "string" && member.includes("/")) add(member.slice(member.indexOf("/") + 1));
  }
  for (const id of upstream) add(id);
  return [...ids].sort((a, b) => b.length - a.length);
}

/**
 * Provider ids behind the combo members ("zai" of "zai/glm-5.3:pre") plus any
 * given. Kept apart from model ids: a provider id is often an ordinary word
 * ("together"), so it is only removed where it names a provider — before "/" or
 * after "provider:" — never replaced inside prose.
 */
export function hiddenProviderIds({ members = [], providers = [], publicName = "" } = {}) {
  const out = new Set();
  const add = (value) => {
    const text = typeof value === "string" ? value.trim() : "";
    if (text.length >= 2 && !String(publicName).startsWith(`${text}/`)) out.add(text);
  };
  for (const member of members) {
    if (typeof member === "string" && member.includes("/")) add(member.slice(0, member.indexOf("/")));
  }
  for (const provider of providers) add(provider);
  return [...out].sort((a, b) => b.length - a.length);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `text` with every hidden model id replaced by the public name, in ONE pass:
 * replacing ids one after another made a shorter id match inside the name just
 * inserted ("glm-5.3:pre" → "glm-5" → "glm-5-5"). Ids only match as whole tokens
 * (not inside a longer word or after "/"), longest first. Provider ids are then
 * removed where they name a provider: "zai/x" → "x", "provider: zai" → "provider".
 */
export function scrubModelIds(text, ids, publicName, providers = []) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  if (ids?.length) {
    // Whole tokens, case-insensitive. A match also takes a variant suffix
    // ("glm-5.3:pre-0905"), so no part of a longer upstream id is left behind.
    // After "/" is allowed on purpose: "models/gemini-2.5-pro" and nested
    // "openrouter/zai/glm-5.3:pre" must be scrubbed; the full "zai/glm-5.3:pre"
    // id still wins at its own start because the alternation is longest first.
    const pattern = new RegExp(
      `(?<![A-Za-z0-9_])(?:${ids.map(escapeRegExp).join("|")})(?:[-.:_][A-Za-z]*\\d[A-Za-z0-9._:-]*)?(?![A-Za-z0-9_])`,
      "gi"
    );
    // A function replacer: "$&" or "$1" in a combo name must stay literal.
    out = out.replace(pattern, () => publicName);
  }
  if (providers?.length) {
    const names = providers.map(escapeRegExp).join("|");
    out = out.replace(new RegExp(`(?<![A-Za-z0-9_])(?:${names})/`, "gi"), "");
    // Only "provider: X" — the bare word "provider" is ordinary prose. The space
    // the removed name leaves behind is tidied here, and only here.
    out = out.replace(new RegExp(`(provider):\\s*(?:${names})(?![A-Za-z0-9_])[ \\t]?`, "gi"), "$1 ")
      .replace(/(provider) (?=[.,;:)]|$)/gi, "$1");
  }
  return out;
}

// An error inside a 200 body or an SSE event (mid-stream failure) is rebuilt like
// an error status: `{ message, type, code }` only (no upstream code, metadata,
// provider_name or raw body), classified by its text since there is no status.
// A string error stays a string. Declared as a function: it uses upstreamError.
function scrubError(error, options) {
  if (typeof error === "string") return upstreamError(0, error, options).message;
  if (error && typeof error === "object") {
    const raw = typeof error.message === "string" ? error.message : JSON.stringify(error);
    return upstreamError(0, raw, options);
  }
  return error;
}

/**
 * Rewrite one parsed JSON body or SSE event in place. Returns the same object.
 * Only the model fields and error texts change.
 */
export function maskModelFields(value, options) {
  const { publicName } = options;
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  if (typeof value.model === "string") value.model = publicName;
  // Aggregators (OpenRouter-style) name the provider that served the request.
  if (typeof value.provider === "string") delete value.provider;
  if (typeof value.modelVersion === "string") value.modelVersion = publicName;
  if (value.message && typeof value.message === "object" && typeof value.message.model === "string") {
    value.message.model = publicName;
  }
  if (value.response && typeof value.response === "object") {
    if (typeof value.response.model === "string") value.response.model = publicName;
    if (value.response.error) value.response.error = scrubError(value.response.error, options);
  }
  if (value.error) value.error = scrubError(value.error, options);
  // A top-level error event (`{ type: "error", code, message, param }`, the
  // Responses API shape) is rebuilt like any other upstream error: its code
  // (e.g. insufficient_quota) and param are the upstream's and are dropped.
  if (value.type === "error" && typeof value.message === "string") {
    const rebuilt = upstreamError(0, value.message, options);
    value.message = rebuilt.message;
    value.code = rebuilt.code;
    delete value.param;
  }
  return value;
}

/** A JSON text masked, or returned as is when it is not JSON. */
export function maskJsonText(text, options) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON (a plain-text error): only the hidden ids can be scrubbed.
    return scrubModelIds(text, options.ids, options.publicName, options.providers);
  }
  return JSON.stringify(maskModelFields(parsed, options));
}

/** One SSE line masked. Only `data:` lines carrying JSON change. */
export function maskSseLine(line, options) {
  if (!line.startsWith("data:")) return line;
  const payload = line.slice(5).trimStart();
  if (!payload || payload === "[DONE]" || (payload[0] !== "{" && payload[0] !== "[")) return line;
  try {
    return `data: ${JSON.stringify(maskModelFields(JSON.parse(payload), options))}`;
  } catch {
    return line;
  }
}

/**
 * A byte TransformStream that masks an SSE stream line by line. A line split
 * across chunks is held until its newline arrives; events keep their order and
 * their blank-line separators.
 */
export function createSseMaskStream(options) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let carry = "";
  return new TransformStream({
    transform(chunk, controller) {
      carry += decoder.decode(chunk, { stream: true });
      const lastBreak = carry.lastIndexOf("\n");
      if (lastBreak < 0) return;
      const complete = carry.slice(0, lastBreak + 1);
      carry = carry.slice(lastBreak + 1);
      const masked = complete
        .split("\n")
        .map((line) => {
          const cr = line.endsWith("\r");
          const body = cr ? line.slice(0, -1) : line;
          return maskSseLine(body, options) + (cr ? "\r" : "");
        })
        .join("\n");
      controller.enqueue(encoder.encode(masked));
    },
    flush(controller) {
      carry += decoder.decode();
      if (carry) controller.enqueue(encoder.encode(maskSseLine(carry, options)));
    },
  });
}

const SIZE_HINTS = REQUEST_ERROR_RULES.texts;

// Texts that are about the operator's provider account, whatever the status
// (Gemini reports a bad key as 400, some gateways as 200 inside the body). A
// customer reading them would think their own key or balance is the problem.
// Phrases, not single words: "forbidden content", "maximum quota of tools" or a
// tool description mentioning billing are request problems the customer must read.
const PROVIDER_ACCOUNT_HINTS = [
  "api key", "api_key", "apikey", "unauthenticated", "authentication failed",
  "invalid authentication", "exceeded your current quota", "insufficient_quota", "quota exceeded",
  "billing details", "billing hard limit", "insufficient credit", "insufficient balance", "credit balance",
  "payment required", "no active credentials", "no credentials", "account has been suspended",
  "account has been deactivated", "account suspended", "account deactivated",
];
const OVERLOAD_HINTS = ["rate limit", "rate_limit", "too many requests", "overloaded", "capacity"];

const GENERIC = {
  provider: "Model tạm thời không khả dụng. Vui lòng thử lại sau.",
  timeout: "Model phản hồi quá lâu. Vui lòng thử lại.",
  busy: "Model đang quá tải. Vui lòng thử lại sau ít phút.",
  server: "Model tạm thời gặp lỗi. Vui lòng thử lại sau.",
  size: "Yêu cầu quá dài so với giới hạn của model. Hãy rút gọn hội thoại rồi thử lại.",
  request: "Model từ chối yêu cầu.",
};

/** "[a/b] [401]: text (reset after 2m)" → "text"; URLs removed; ids scrubbed. */
export function cleanUpstreamMessage(message, options) {
  let text = typeof message === "string" ? message : "";
  text = text.replace(/^(\s*\[[^\]]*\]:?\s*)+/, "");
  text = text.replace(/\s*\(reset after [^)]*\)\s*$/i, "");
  // A JSON body pasted into the message: keep only its inner message.
  const brace = text.indexOf("{");
  if (brace >= 0) {
    try {
      const inner = JSON.parse(text.slice(brace));
      const innerMessage = inner?.error?.message || inner?.message;
      if (typeof innerMessage === "string") text = innerMessage;
    } catch { /* not JSON: keep the text */ }
  }
  // URLs, cloud resource paths (Vertex "projects/<id>/locations/…") and bare
  // host names (ENOTFOUND, gateway titles) name the provider or the operator.
  text = text.replace(/https?:\/\/\S+/g, "");
  text = text.replace(/\bprojects\/[^\s"'`,;)]+/g, "");
  text = text.replace(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|ai|dev|app|cloud|vn|cn|co|xyz|internal|local)\b(?::\d+)?/gi, "");
  // Tidy the gaps left by removals, on one line only: line breaks and code
  // blocks in an upstream explanation stay as they were.
  text = text.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+([.,:;])/g, "$1").trim();
  return scrubModelIds(text, options.ids, options.publicName, options.providers);
}

/**
 * The customer-facing `{ message, type, code }` for an upstream error with this
 * status. The upstream's own code is never passed on: an upstream
 * "invalid_api_key" is about the operator's provider account, and a customer
 * reading it would believe their own key is wrong.
 */
export function upstreamError(status, rawMessage, options) {
  const lower = String(rawMessage || "").toLowerCase();
  const busy = { message: GENERIC.busy, type: "rate_limit_error", code: "model_overloaded" };
  // 429 first: "Request too large … tokens per min" is a rate limit, not a size problem.
  if (status === 429) return busy;
  if (status === 401 || status === 402 || status === 403 || status === 407
      || PROVIDER_ACCOUNT_HINTS.some((hint) => lower.includes(hint))) {
    return { message: GENERIC.provider, type: "server_error", code: "model_unavailable" };
  }
  if (status === 413 || SIZE_HINTS.some((hint) => lower.includes(hint))) {
    return { message: GENERIC.size, type: "invalid_request_error", code: "context_length_exceeded" };
  }
  if (status === 408 || status === 504) return { message: GENERIC.timeout, type: "server_error", code: "model_timeout" };
  if (status === 0 && OVERLOAD_HINTS.some((hint) => lower.includes(hint))) return busy;
  if (status >= 500) return { message: GENERIC.server, type: "server_error", code: "model_error" };
  return {
    message: cleanUpstreamMessage(rawMessage, options) || GENERIC.request,
    type: "invalid_request_error",
    code: "invalid_request",
  };
}

/** An error body rebuilt for a customer key (see the header comment). */
export function maskErrorBody(parsed, status, { platform = false, ...options }) {
  const error = parsed && typeof parsed === "object" ? (parsed.error ?? parsed) : null;
  const rawMessage = typeof error === "string" ? error : (error?.message ?? (typeof parsed === "string" ? parsed : ""));
  if (platform) {
    const kept = parsed && typeof parsed === "object" ? { ...parsed } : { error: { message: rawMessage } };
    if (kept.error && typeof kept.error === "object") {
      kept.error = { ...kept.error, message: scrubModelIds(String(kept.error.message ?? ""), options.ids, options.publicName, options.providers) };
    }
    return kept;
  }
  // A combo that ran out of models answers 503 but keeps the cause's status in
  // the text ("[400]: ..."): classify by that, so a problem with the request
  // still reads as one. The HTTP status itself is not changed.
  const inner = /\[(\d{3})\]:/.exec(String(rawMessage || ""));
  const effective = inner ? Number(inner[1]) : status;
  const out = { error: upstreamError(effective, rawMessage, options) };
  // Claude-format clients look at the top-level `type`.
  if (parsed?.type === "error") out.type = "error";
  return out;
}

/**
 * The response with its model fields and error texts masked. SSE is masked as
 * it streams; JSON (and plain-text errors) are read and rewritten. Anything
 * else (audio, images) is returned unchanged.
 */
export async function maskResponse(response, options) {
  if (!response || !options?.publicName) return response;
  const type = (response.headers.get("content-type") || "").toLowerCase();
  const headers = new Headers(response.headers);
  headers.delete("content-length");

  if (type.includes("text/event-stream")) {
    if (!response.body) return response;
    return new Response(response.body.pipeThrough(createSseMaskStream(options)), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  if (response.status >= 400 && (type.includes("json") || type.startsWith("text/") || !type)) {
    const text = await response.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch { /* plain text */ }
    const platform = response.headers.get(PLATFORM_ERROR_HEADER) === "platform";
    headers.set("content-type", "application/json");
    return new Response(JSON.stringify(maskErrorBody(parsed, response.status, { ...options, platform })), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  // A 200 JSON body: model fields only. A 200 text body is content and is left alone.
  if (type.includes("json")) {
    const text = await response.text();
    return new Response(maskJsonText(text, options), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  return response;
}

/**
 * A stored copy of a response (request details shown to the key holder) with
 * every `model` / `modelVersion` field, at any depth, set to the public name and
 * error texts scrubbed. SSE text is masked line by line. Content is untouched.
 */
export function maskStoredResponse(value, options) {
  if (value == null) return value;
  if (typeof value === "string") {
    if (value.includes("data:")) {
      return value.split("\n").map((line) => {
        const cr = line.endsWith("\r");
        const body = cr ? line.slice(0, -1) : line;
        return maskSseLine(body, options) + (cr ? "\r" : "");
      }).join("\n");
    }
    return maskJsonText(value, options);
  }
  // Strings inside arrays are request/response content (inputs, stop words, enum
  // values): left exactly as stored. Objects inside them are still masked.
  if (Array.isArray(value)) return value.map((item) => (item && typeof item === "object" ? maskStoredResponse(item, options) : item));
  if (typeof value !== "object") return value;
  // A stored error row `{ error: "<upstream text>", status }`: rebuilt exactly as
  // the live error was for the customer (spec model-privacy), not just cleaned.
  if (value.error != null && typeof value.status === "number") {
    const raw = typeof value.error === "string" ? value.error : (value.error?.message ?? JSON.stringify(value.error));
    const inner = /\[(\d{3})\]:/.exec(String(raw));
    const rebuilt = upstreamError(inner ? Number(inner[1]) : value.status, raw, options);
    return { ...maskStoredResponse({ ...value, error: undefined }, options), error: rebuilt.message, code: rebuilt.code };
  }
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if ((key === "model" || key === "modelVersion") && typeof inner === "string") out[key] = options.publicName;
    else if (key === "error") out[key] = scrubError(maskStoredResponse(inner, options), options);
    else if (inner && typeof inner === "object") out[key] = maskStoredResponse(inner, options);
    else out[key] = inner;
  }
  return out;
}
