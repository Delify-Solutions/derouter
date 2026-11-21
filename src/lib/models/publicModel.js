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
//     actually used) replaced by that name;
//   - provider-identifying fields are removed, usage keeps its format's
//     standard counts only, and chat/Claude/Gemini response ids become one
//     router-generated id per response (see stripProviderFields);
//   - a JSON document that answered a streamed request is masked as a document
//     (createSseMaskStream).
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
import { createJsonPrefixParser, PREFIX } from "./jsonPrefix.js";
// Notes the pre-mask error body for the admin error log (spec error-log "raw error response").
import { noteRawErrorResponse } from "../../../open-sse/utils/errorTrace.js";

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

// ── Provider-identifying fields (spec model-privacy "Responses name the combo") ──
//
// Besides the model, a response names its provider through fields no client
// needs: an OpenAI system fingerprint, Groq's `x_groq`, OpenRouter's
// `native_finish_reason`, Azure's content-filter results, and usage extras
// (OpenRouter `cost` = the operator's cost price, `cost_details`, `is_byok`;
// DeepSeek `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens`; Vertex
// `trafficType`). Usage keeps only its format's standard token counts — the
// figures usage-accuracy requires a client to see (the router never sends a
// client anything else; `estimated` is internal). Provider-prefixed ids
// (OpenRouter `gen-…`, Bedrock/Vertex `msg_bdrk_`/`msg_vrtx_`) become one
// router-generated id per response. Responses API ids are chained by clients
// (`previous_response_id`) and tool-call ids are referenced by the next request:
// neither is touched.

/** Top-level fields removed from every masked body or event. */
const PROVIDER_FIELDS = ["system_fingerprint", "x_groq", "prompt_filter_results"];
/** Fields removed from each `choices[]` entry. */
const PROVIDER_CHOICE_FIELDS = ["native_finish_reason", "content_filter_results"];

// Allowed usage fields per format. `fields` keep numbers (or null); `details`
// keep an object with only the listed numeric keys; `modalities` keep Gemini's
// `[{ modality, tokenCount }]` arrays.
const USAGE_FORMATS = {
  openai: {
    // `cached_tokens` / `reasoning_tokens` at the top: the router's own compat
    // whitelist (filterUsageForFormat) may emit them.
    fields: ["prompt_tokens", "completion_tokens", "total_tokens", "cached_tokens", "reasoning_tokens"],
    details: {
      // `cache_creation_tokens`: the router's own field (buildUsage, for Claude,
      // Kiro, Command Code and Qoder upstreams): cache writes are billed, so the
      // customer must see them.
      prompt_tokens_details: ["cached_tokens", "cache_creation_tokens", "audio_tokens"],
      completion_tokens_details: ["reasoning_tokens", "audio_tokens", "accepted_prediction_tokens", "rejected_prediction_tokens"],
    },
  },
  claude: {
    fields: ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"],
    details: {
      cache_creation: ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"],
      server_tool_use: ["web_search_requests", "web_fetch_requests"],
    },
  },
  responses: {
    fields: ["input_tokens", "output_tokens", "total_tokens"],
    details: {
      input_tokens_details: ["cached_tokens"],
      output_tokens_details: ["reasoning_tokens"],
    },
  },
  gemini: {
    fields: ["promptTokenCount", "candidatesTokenCount", "totalTokenCount", "cachedContentTokenCount", "thoughtsTokenCount", "toolUsePromptTokenCount"],
    modalities: ["promptTokensDetails", "candidatesTokensDetails", "cacheTokensDetails", "toolUsePromptTokensDetails"],
  },
  embeddings: {
    fields: ["prompt_tokens", "total_tokens"],
  },
  // OpenAI image generations and edits (gpt-image), JSON bodies and the
  // `image_generation.*` / `image_edit.*` stream events: token usage of the request.
  images: {
    fields: ["input_tokens", "output_tokens", "total_tokens"],
    details: {
      input_tokens_details: ["text_tokens", "image_tokens"],
      output_tokens_details: ["text_tokens", "image_tokens"],
    },
  },
};

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** `usage` reduced to the standard fields of `format`, in the upstream's order. */
export function pickUsage(usage, format) {
  const spec = USAGE_FORMATS[format];
  if (!spec || !isPlainObject(usage)) return usage;
  const out = {};
  for (const [key, value] of Object.entries(usage)) {
    if (spec.fields.includes(key)) {
      if (typeof value === "number" || value === null) out[key] = value;
    } else if (spec.details?.[key]) {
      if (!isPlainObject(value)) continue;
      const allowed = spec.details[key];
      const detail = {};
      for (const [inner, count] of Object.entries(value)) {
        if (allowed.includes(inner) && typeof count === "number") detail[inner] = count;
      }
      out[key] = detail;
    } else if (spec.modalities?.includes(key) && Array.isArray(value)) {
      out[key] = value.filter(isPlainObject).map((entry) => {
        const kept = {};
        if (typeof entry.modality === "string") kept.modality = entry.modality;
        if (typeof entry.tokenCount === "number") kept.tokenCount = entry.tokenCount;
        return kept;
      });
    }
  }
  return out;
}

const ID_PREFIX = { chat: "chatcmpl-", message: "msg_", gemini: "" };

/**
 * The router's id of one kind for this response: created on first use and
 * reused for every later chunk or event, so a stream carries one id throughout
 * even if the upstream varied its own. `state` is a Map per response.
 */
function publicId(kind, state) {
  if (!state.has(kind)) state.set(kind, `${ID_PREFIX[kind]}${globalThis.crypto.randomUUID().replace(/-/g, "")}`);
  return state.get(kind);
}

/** The format a top-level body or event is in, for its usage, or null. */
function bodyFormat(value) {
  const object = typeof value.object === "string" ? value.object : "";
  if (object.startsWith("chat.completion") || object === "text_completion" || Array.isArray(value.choices)) return "openai";
  if (value.type === "message" || value.type === "message_delta") return "claude";
  if (object === "response") return "responses";
  if (typeof value.type === "string" && /^image_(generation|edit)\./.test(value.type)) return "images";
  if (Array.isArray(value.data)) {
    if (value.data.some((item) => item?.object === "embedding" || Array.isArray(item?.embedding))) return "embeddings";
    if (value.created != null && value.data.some((item) => isPlainObject(item) && ("url" in item || "b64_json" in item))) return "images";
  }
  return null;
}

/**
 * Remove provider-identifying fields from one parsed body or event, allow-list
 * its usage and replace its provider ids (see the comment above PROVIDER_FIELDS).
 * In place. `state` keeps the router's ids for the whole response.
 */
function stripProviderFields(value, state) {
  for (const field of PROVIDER_FIELDS) delete value[field];
  if (Array.isArray(value.choices)) {
    for (const choice of value.choices) {
      if (isPlainObject(choice)) for (const field of PROVIDER_CHOICE_FIELDS) delete choice[field];
    }
  }

  const format = bodyFormat(value);
  if (format && isPlainObject(value.usage)) value.usage = pickUsage(value.usage, format);
  // OpenAI chat completions and chunks; a Claude message (non-streamed reply).
  if (format === "openai" && typeof value.id === "string") value.id = publicId("chat", state);
  if (value.type === "message" && typeof value.id === "string") value.id = publicId("message", state);

  // Claude message_start carries the message (id, usage) one level down.
  if (value.type === "message_start" && isPlainObject(value.message)) {
    if (typeof value.message.id === "string") value.message.id = publicId("message", state);
    if (isPlainObject(value.message.usage)) value.message.usage = pickUsage(value.message.usage, "claude");
  }
  // Responses API events: the response object (its id is the client's handle, kept).
  if (typeof value.type === "string" && value.type.startsWith("response.") && isPlainObject(value.response)
      && isPlainObject(value.response.usage)) {
    value.response.usage = pickUsage(value.response.usage, "responses");
  }
  // Gemini, at the top or wrapped in `response` (Antigravity / Gemini CLI clients).
  for (const target of [value, isPlainObject(value.response) ? value.response : null]) {
    if (!target) continue;
    if (isPlainObject(target.usageMetadata)) target.usageMetadata = pickUsage(target.usageMetadata, "gemini");
    if (typeof target.responseId === "string") target.responseId = publicId("gemini", state);
  }
}

/**
 * Rewrite one parsed JSON body or SSE event in place. Returns the same object.
 * Only the model fields, provider-identifying fields (usage extras and provider
 * ids included) and error texts change; content never does. `options.responseIds`
 * (a Map) keeps the router's ids consistent across the events of one response;
 * without it the ids are consistent within this one value.
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
    // Gemini CLI / Antigravity clients get the Gemini body wrapped in `response`.
    if (typeof value.response.modelVersion === "string") value.response.modelVersion = publicName;
    if (value.response.error) value.response.error = scrubError(value.response.error, options);
  }
  stripProviderFields(value, options.responseIds instanceof Map ? options.responseIds : new Map());
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

/** A parsed JSON value masked: an object, or each object of a top-level array (Gemini). */
function maskParsed(parsed, options) {
  if (Array.isArray(parsed)) return parsed.map((item) => maskModelFields(item, options));
  return maskModelFields(parsed, options);
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
  return JSON.stringify(maskParsed(parsed, options));
}

const BOM = "﻿";

/**
 * One SSE line masked. A `data:` line carrying JSON is masked field by field; a
 * `data:` line that is not JSON (or is broken JSON) is upstream text — in the
 * chat protocols every data payload is JSON, so such a line is an error or a
 * gateway message — and has URLs, host names and hidden ids removed
 * (scrubUpstreamText). Other lines (`event:`, comments, blank) are unchanged. A
 * byte-order mark in front of the line (first line of a body) is kept and does
 * not hide the line from the mask.
 */
export function maskSseLine(line, options) {
  if (line.startsWith(BOM)) return BOM + maskSseLine(line.slice(1), options);
  if (!line.startsWith("data:")) return line;
  const payload = line.slice(5).trimStart();
  if (!payload || payload === "[DONE]") return line;
  if (payload[0] === "{" || payload[0] === "[") {
    try {
      return `data: ${JSON.stringify(maskParsed(JSON.parse(payload), options))}`;
    } catch { /* broken JSON: treated as text below */ }
  }
  if (payload[0] === "\"") {
    // A bare JSON string is upstream text too (see D8), but it stays a JSON string:
    // its text is scrubbed and quoted again (a URL scrub must not eat the quote).
    try {
      const text = JSON.parse(payload);
      if (typeof text === "string") {
        const cleaned = scrubUpstreamText(text, options);
        return cleaned === text ? line : `data: ${JSON.stringify(cleaned)}`;
      }
    } catch { /* not one JSON string: text below */ }
  }
  const scrubbed = scrubUpstreamText(payload, options);
  return scrubbed === payload ? line : `data: ${scrubbed}`;
}

// Keys whose pairs are cut out of a broken JSON fragment: the provider-identifying
// fields and usage extras stripProviderFields removes from a whole value.
const FRAGMENT_DROP_KEYS = [
  "provider", "system_fingerprint", "x_groq", "native_finish_reason", "prompt_filter_results",
  "content_filter_results", "cost", "cost_details", "is_byok", "prompt_cache_hit_tokens",
  "prompt_cache_miss_tokens", "trafficType",
];
const FRAGMENT_DROP_PATTERN = new RegExp(`"(?:${FRAGMENT_DROP_KEYS.join("|")})"\\s*:\\s*`, "g");

/** Index just past the JSON value starting at `i` (or the end of a cut value). */
function skipJsonValue(text, i) {
  const first = text[i];
  if (first === "\"") {
    for (let j = i + 1; j < text.length; j += 1) {
      if (text[j] === "\\") j += 1;
      else if (text[j] === "\"") return j + 1;
    }
    return text.length;
  }
  if (first === "{" || first === "[") {
    let depth = 0;
    let inString = false;
    for (let j = i; j < text.length; j += 1) {
      const ch = text[j];
      if (inString) {
        if (ch === "\\") j += 1;
        else if (ch === "\"") inString = false;
        continue;
      }
      if (ch === "\"") inString = true;
      else if (ch === "{" || ch === "[") depth += 1;
      else if (ch === "}" || ch === "]") {
        depth -= 1;
        if (depth === 0) return j + 1;
      }
    }
    return text.length;
  }
  let j = i;
  while (j < text.length && !/[,}\]\s]/.test(text[j])) j += 1;
  return j;
}

/** `text` with every `"key": value` pair of FRAGMENT_DROP_KEYS cut out, commas tidied. */
function dropFragmentPairs(text) {
  let out = "";
  let last = 0;
  FRAGMENT_DROP_PATTERN.lastIndex = 0;
  for (let match = FRAGMENT_DROP_PATTERN.exec(text); match; match = FRAGMENT_DROP_PATTERN.exec(text)) {
    if (match.index < last) continue;
    let end = skipJsonValue(text, match.index + match[0].length);
    const after = /^\s*,/.exec(text.slice(end));
    let keep = text.slice(last, match.index);
    if (after) end += after[0].length;
    else keep = keep.replace(/,\s*$/, "");
    out += keep;
    last = end;
    FRAGMENT_DROP_PATTERN.lastIndex = Math.max(end, match.index + 1);
  }
  return out + text.slice(last);
}

/**
 * The quoted-JSON forms inside upstream text (a broken or cut JSON fragment, a
 * JSON body pasted into an error): the provider-identifying pairs are cut out,
 * `model` / `modelVersion` values name the combo and provider-prefixed response
 * ids (`gen-…`, `chatcmpl-…`, `msg_…`) become the router's. Tool-call ids
 * (`call_…`, `toolu_…`) are left alone. Part of scrubUpstreamText.
 */
function scrubJsonForms(text, options) {
  if (!text.includes("\"")) return text;
  const state = options.responseIds instanceof Map ? options.responseIds : new Map();
  return dropFragmentPairs(text)
    .replace(/("(?:model|modelVersion)"\s*:\s*)"(?:[^"\\]|\\.)*"/g, (_, key) => `${key}${JSON.stringify(options.publicName)}`)
    .replace(/("id"\s*:\s*)"(gen-|chatcmpl-|msg_)(?:[^"\\]|\\.)*"/g, (_, key, prefix) =>
      `${key}"${publicId(prefix === "msg_" ? "message" : "chat", state)}"`);
}

// The largest JSON document answering a streamed request that is masked. The
// engine's passthrough (open-sse/utils/stream.js, "docMode") stops reading such
// a document for usage past this same cap, so nothing larger is billed either.
const DOCUMENT_MAX_CHARS = Number(process.env.STREAM_MAX_BUFFER_BYTES || 4 * 1024 * 1024);

/**
 * A JSON document that answered a streamed request (sent under SSE headers),
 * masked exactly like a JSON response: an error status is rebuilt by
 * maskErrorBody, anything else has its model/provider fields and embedded errors
 * masked. A body that is not one JSON value is masked as JSON lines; a line that
 * is not JSON is scrubbed as upstream text (scrubUpstreamText). A leading
 * byte-order mark is dropped (JSON.parse rejects it).
 */
export function maskJsonDocument(text, options, { status = 200, platform = false } = {}) {
  if (text.startsWith(BOM)) text = text.slice(1);
  if (status >= 400) {
    let parsed = text;
    try { parsed = JSON.parse(text); } catch { /* error text */ }
    return JSON.stringify(maskErrorBody(parsed, status, { ...options, platform }));
  }
  try {
    return JSON.stringify(maskParsed(JSON.parse(text), options));
  } catch { /* JSON lines, or a cut document */ }
  return text.split("\n").map((line) => {
    const cr = line.endsWith("\r");
    const body = (cr ? line.slice(0, -1) : line).trim();
    if (!body) return line;
    try {
      return JSON.stringify(maskParsed(JSON.parse(body), options)) + (cr ? "\r" : "");
    } catch {
      return scrubUpstreamText(body, options) + (cr ? "\r" : "");
    }
  }).join("\n");
}

// ── SSE events ─────────────────────────────────────────────────────────────
//
// One SSE event may carry its data on several `data:` lines; a client joins
// them with "\n" (WHATWG SSE). A JSON payload split that way is not broken JSON:
// masking each line on its own scrubbed content as if it were error text and
// let the fields through. But many upstreams never send the blank line that
// ends an event (the engine's passthrough forwards their lines as received), so
// waiting for it would hold a whole stream. The mask therefore releases data as
// soon as it is complete (createSseEventMasker):
//   - a data line whose payload is not JSON-shaped (text, `[DONE]`) at once;
//   - JSON data is followed by a JSON grammar check (jsonPrefix.js) and released
//     the moment it is a complete value, so one line of a normal stream leaves
//     the moment it arrives; or the moment it can never become one (for example
//     `{"a":` followed by `{…}` and another `{`): the held lines then go out one
//     by one and the line that broke them starts afresh. Only the first lines of
//     a value split over several lines are held, until its last line;
//   - pending data when an `event:` line or a blank line arrives, and at the end;
//   - other lines (`event:`, `id:`, comments) at once when no data is pending.
// Pending data (or one line still arriving) is capped at DOCUMENT_MAX_CHARS;
// past that one `model_error` line is released, every further line of that
// value is dropped (the grammar check tells exactly where it ends), and the
// stream goes on.

const EVENT_MAX_CHARS = DOCUMENT_MAX_CHARS;

const stripBom = (text) => (text.startsWith(BOM) ? text.slice(1) : text);

/** The data of a `data:` line, as SSE reads it (one leading space dropped). */
function dataPayload(body) {
  const value = stripBom(body).slice(5);
  return value.startsWith(" ") ? value.slice(1) : value;
}

const isDataLine = (body) => stripBom(body).startsWith("data:");

/**
 * A line that carries no data, masked: an `id:` line's value is upstream text
 * (a generation id may embed a model or host) and goes through
 * scrubUpstreamText; the router writes no `id:` lines of its own. `event:`,
 * `retry:` and comment lines are unchanged.
 */
function maskSseControlLine(body, options) {
  const plain = stripBom(body);
  if (!plain.startsWith("id:")) return body;
  const value = plain.slice(3).startsWith(" ") ? plain.slice(4) : plain.slice(3);
  const scrubbed = scrubUpstreamText(value, options);
  return scrubbed === value ? body : `${body.startsWith(BOM) ? BOM : ""}id: ${scrubbed}`;
}

/**
 * Pending lines of one event masked. Each line is `{ body, end }` where `end` is
 * its original terminator ("\r\n", "\n" or "" for an unterminated tail); lines
 * keep their order and terminators.
 * - Several data lines whose joined payload is one JSON value: masked once and
 *   written as one `data:` line where the first one was (a client joining the
 *   lines reads the same value).
 * - Otherwise each data line on its own (maskSseLine): a line that is JSON is
 *   masked as JSON, never scrubbed as text; only a line that is not JSON is.
 * - Other lines: maskSseControlLine.
 */
function maskSseEvent(lines, options) {
  const dataAt = [];
  lines.forEach((line, index) => { if (isDataLine(line.body)) dataAt.push(index); });
  const each = () => lines
    .map((line) => (isDataLine(line.body) ? maskSseLine(line.body, options) : maskSseControlLine(line.body, options)) + line.end)
    .join("");
  if (dataAt.length <= 1) return each();

  const joined = dataAt.map((index) => dataPayload(lines[index].body)).join("\n");
  const head = joined.trimStart()[0];
  if (head !== "{" && head !== "[") return each();
  let masked;
  try {
    masked = JSON.stringify(maskParsed(JSON.parse(joined), options));
  } catch {
    return each();
  }
  const bom = lines[dataAt[0]].body.startsWith(BOM) ? BOM : "";
  const joinedLines = new Set(dataAt); // O(1) membership: a value may span many lines
  return lines.map((line, index) => {
    if (index === dataAt[0]) return `${bom}data: ${masked}${line.end}`;
    if (joinedLines.has(index)) return "";
    return maskSseControlLine(line.body, options) + line.end;
  }).join("");
}

/** A JSON-shaped payload: the start of an object or array. */
function jsonShaped(payload) {
  const head = payload.trimStart()[0];
  return head === "{" || head === "[";
}

/**
 * An incremental SSE masker (rules in the comment at the top of this section):
 * `push` complete lines (with their terminator), read what is ready with `take`,
 * and `end` at the end of the stream. A line that outgrows the cap while still
 * arriving is reported with `overflowLine` (its start), `discardText` (the rest)
 * and `endDiscardLine` (its newline): none of it is ever released.
 */
function createSseEventMasker(options) {
  let pending = []; // lines of the value still being collected
  let parser = null; // its JSON prefix state
  let size = 0;
  // Dropping the rest of a value that outgrew the cap: `parser` follows it so the
  // drop ends exactly where the value does; `inLine` while its line still arrives.
  let discard = null;
  let out = "";

  const reset = () => { pending = []; parser = null; size = 0; };
  const release = () => {
    if (pending.length) out += maskSseEvent(pending, options);
    reset();
  };
  const failClosed = () => {
    out += `data: ${JSON.stringify({ error: upstreamError(500, "", options) })}\n`;
  };
  const overflow = () => {
    failClosed();
    discard = { parser, inLine: false };
    reset();
  };
  const settle = (status) => {
    if (status === PREFIX.INCOMPLETE) {
      if (size > EVENT_MAX_CHARS) overflow();
      return;
    }
    // Complete: one value, masked once. Invalid: it can never be one; its lines
    // are masked one by one (JSON lines as JSON, the rest as upstream text).
    release();
  };

  /** A data line with nothing pending. */
  const startData = (line, payload, length) => {
    if (!jsonShaped(payload)) {
      // Text, `[DONE]`, empty data: nothing to join, out now.
      out += maskSseEvent([line], options);
      return;
    }
    parser = createJsonPrefixParser();
    pending = [line];
    size = length;
    settle(parser.feed(payload));
  };

  /** A data line while a value is being collected. */
  const continueData = (line, payload, length) => {
    if (parser.feed(`\n${payload}`) === PREFIX.INVALID) {
      // The held lines can never become a value with this line: out now, one by
      // one, and this line starts afresh (it may well be the next event).
      const held = pending;
      reset();
      out += maskSseEvent(held, options);
      startData(line, payload, length);
      return;
    }
    pending.push(line);
    size += length;
    settle(parser.status);
  };

  /** True when the line belongs to the dropped value (and is dropped). */
  const discarded = (payload) => {
    if (!discard?.parser) { discard = null; return false; }
    const status = discard.parser.feed(`\n${payload}`);
    if (status === PREFIX.INCOMPLETE) return true; // still inside the dropped value
    discard = null;
    // Complete: this was its last line, dropped too. Invalid: this line is not
    // part of it and starts afresh.
    return status === PREFIX.COMPLETE;
  };

  return {
    push(raw, terminator) {
      const cr = raw.endsWith("\r");
      const body = cr ? raw.slice(0, -1) : raw;
      const end = (cr ? "\r" : "") + terminator;
      const plain = stripBom(body);
      const line = { body, end };
      const length = raw.length + 1;

      if (plain === "") {
        // The blank line that ends an event.
        release();
        discard = null;
        out += body + end;
        return;
      }

      if (plain.startsWith("data:")) {
        const payload = dataPayload(body);
        if (discard && discarded(payload)) return;
        if (pending.length) continueData(line, payload, length);
        else startData(line, payload, length);
        return;
      }

      if (plain.startsWith("event:")) {
        // A new event starts: whatever was pending or being dropped is over.
        release();
        discard = null;
      }
      if (!pending.length) {
        out += maskSseControlLine(body, options) + end;
        return;
      }
      pending.push(line);
      size += length;
      if (size > EVENT_MAX_CHARS) overflow();
    },
    /** `partial` (the start of a line still arriving) has outgrown the cap. */
    overflowLine(partial) {
      const plain = stripBom(partial.endsWith("\r") ? partial.slice(0, -1) : partial);
      if (!plain.startsWith("data:")) {
        // An oversized comment or `event:`/`id:` line carries no content: dropped.
        discard = { parser: discard?.parser ?? null, inLine: true, quiet: true };
        return;
      }
      const payload = dataPayload(partial);
      const fresh = () => {
        if (!jsonShaped(payload)) return null;
        const created = createJsonPrefixParser();
        created.feed(payload);
        return created;
      };
      let follow;
      let continuation = false; // the line continues a value already being dropped
      if (pending.length) {
        follow = parser;
        if (follow.feed(`\n${payload}`) === PREFIX.INVALID) {
          // Not part of the held value: the held lines go out as they are, this
          // oversized line is a value of its own.
          const held = pending;
          reset();
          out += maskSseEvent(held, options);
          follow = fresh();
        }
      } else if (discard?.parser && discard.parser.feed(`\n${payload}`) !== PREFIX.INVALID) {
        follow = discard.parser;
        continuation = true;
      } else {
        follow = fresh();
      }
      // The line's start never left; what was pending with it goes with it.
      reset();
      if (!continuation) failClosed();
      discard = { parser: follow, inLine: true };
    },
    /** More of the line being dropped. */
    discardText(text) {
      if (discard?.inLine && discard.parser && !discard.quiet) discard.parser.feed(text);
    },
    /** The newline of the line being dropped. */
    endDiscardLine() {
      if (!discard) return;
      discard.inLine = false;
      if (discard.quiet) { discard = discard.parser ? { parser: discard.parser, inLine: false } : null; return; }
      if (!discard.parser || discard.parser.status !== PREFIX.INCOMPLETE) discard = null;
    },
    end() { release(); },
    take() {
      const text = out;
      out = "";
      return text;
    },
  };
}

/** A complete SSE text masked by the same rules as a live stream (stored copies). */
export function maskSseText(text, options) {
  const masker = createSseEventMasker(options);
  const lines = String(text).split("\n");
  lines.forEach((line, index) => masker.push(line, index < lines.length - 1 ? "\n" : ""));
  masker.end();
  return masker.take();
}

/**
 * A byte TransformStream that masks an SSE stream (createSseEventMasker). A line
 * split across network chunks is held until its newline arrives; a complete line
 * is released in the same chunk unless it is the start of a JSON value that
 * continues on the next data line. Lines keep their order, their terminators and
 * the blank-line separators; nothing is added.
 *
 * A body whose first non-blank character is `{` or `[` is not SSE but a JSON
 * document answering a streamed request (forwarded under SSE headers): it is
 * held whole and masked once at the end (maskJsonDocument), up to
 * DOCUMENT_MAX_CHARS. Past that the mask fails closed with a `model_error`
 * error: forwarding it unmasked would leak what the mask exists to hide.
 * `status` and `platform` are the response's, for an error document.
 */
export function createSseMaskStream(options, { status = 200, platform = false } = {}) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  // One set of router ids for every event of this response.
  const opts = options.responseIds instanceof Map ? options : { ...options, responseIds: new Map() };
  let mode = null; // null until the first non-blank character, then "sse" | "document"
  let pending = "";
  let documentText = "";
  let overflow = false;
  let carry = "";
  let skippingLine = false; // dropping the rest of a line that outgrew the event cap
  const masker = createSseEventMasker(opts);

  const keepDocument = (text) => {
    if (overflow) return;
    documentText += text;
    if (documentText.length > DOCUMENT_MAX_CHARS) {
      overflow = true;
      documentText = "";
    }
  };

  // Lines are cut out of each new chunk only: the carried start of a line is never
  // searched again, so a long line costs O(its length), not O(length²).
  const takeSse = (text, controller) => {
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf("\n", start);
      if (skippingLine) {
        // The rest of a line that outgrew the cap: never released.
        if (newline < 0) {
          masker.discardText(text.slice(start));
          break;
        }
        masker.discardText(text.slice(start, newline));
        masker.endDiscardLine();
        skippingLine = false;
        start = newline + 1;
        continue;
      }
      if (newline < 0) {
        carry += text.slice(start);
        if (carry.length > EVENT_MAX_CHARS) {
          masker.overflowLine(carry);
          carry = "";
          skippingLine = true;
        }
        break;
      }
      const line = carry + text.slice(start, newline);
      carry = "";
      start = newline + 1;
      masker.push(line, "\n");
    }
    const masked = masker.take();
    if (masked) controller.enqueue(encoder.encode(masked));
  };

  return new TransformStream({
    transform(chunk, controller) {
      let text = decoder.decode(chunk, { stream: true });
      if (mode === null) {
        pending += text;
        const first = pending.trimStart();
        if (!first) return;
        mode = first[0] === "{" || first[0] === "[" ? "document" : "sse";
        text = pending;
        pending = "";
      }
      if (mode === "document") keepDocument(text);
      else takeSse(text, controller);
    },
    flush(controller) {
      const tail = decoder.decode();
      if (mode === null) {
        // Only blank text (or nothing) arrived.
        if (pending + tail) controller.enqueue(encoder.encode(pending + tail));
        return;
      }
      if (mode === "document") {
        keepDocument(tail);
        const masked = overflow
          ? JSON.stringify({ error: upstreamError(500, "", opts) })
          : maskJsonDocument(documentText, opts, { status, platform });
        controller.enqueue(encoder.encode(masked));
        return;
      }
      if (tail) takeSse(tail, controller);
      if (skippingLine) masker.endDiscardLine();
      else if (carry) masker.push(carry, "");
      carry = "";
      masker.end();
      const masked = masker.take();
      if (masked) controller.enqueue(encoder.encode(masked));
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
  return scrubUpstreamText(text, options);
}

/**
 * Free upstream text with everything that names the upstream removed: quoted
 * JSON forms (scrubJsonForms), URLs, cloud resource paths, host names, then the
 * hidden model and provider ids. Used for error messages, `id:` values and SSE /
 * JSON-lines text that is not JSON (an error line or a broken JSON fragment).
 */
export function scrubUpstreamText(message, options) {
  // Quoted JSON forms first (`"provider":"zai"`, `"id":"gen-…"`, `"model":"…"`).
  let text = scrubJsonForms(typeof message === "string" ? message : "", options);
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
  // One set of router-generated ids for this response (see stripProviderFields).
  options = { ...options, responseIds: new Map() };
  const type = (response.headers.get("content-type") || "").toLowerCase();
  const headers = new Headers(response.headers);
  headers.delete("content-length");

  if (type.includes("text/event-stream")) {
    if (!response.body) return response;
    const platform = response.headers.get(PLATFORM_ERROR_HEADER) === "platform";
    return new Response(response.body.pipeThrough(createSseMaskStream(options, { status: response.status, platform })), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  if (response.status >= 400 && (type.includes("json") || type.startsWith("text/") || !type)) {
    const text = await response.text();
    // The error log (spec error-log) must show the raw error response, but this function
    // replaces the upstream's own wording with a generic sentence. Note the text first,
    // so the entry keeps the field that names the fault ("param":"tool_choice") while the
    // customer still receives the masked one. Doing it here, at the single place every
    // handler masks, means a new handler cannot forget it.
    noteRawErrorResponse(text);
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
 * error texts scrubbed. SSE text is masked event by event. Content is untouched.
 */
export function maskStoredResponse(value, options) {
  if (value == null) return value;
  // One set of router ids per stored copy, as for a live response.
  if (!(options.responseIds instanceof Map)) options = { ...options, responseIds: new Map() };
  if (typeof value === "string") {
    // A JSON document (also one whose content mentions "data:") is masked as JSON;
    // SSE text only when a line is an SSE field; anything else is text.
    const head = value.trimStart().replace(/^﻿/, "")[0];
    if (head === "{" || head === "[") return maskJsonDocument(value, options);
    if (/^﻿?(?:data|event):/m.test(value)) return maskSseText(value, options);
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
    // The cut preview of a truncated payload (requestDetailsRepo truncateField) is
    // the first 200 characters of raw JSON text: it can hold the upstream model,
    // the provider or anything else mid-string, so a customer never gets it. The
    // `_truncated` marker and the size stay.
    if (key === "_preview") continue;
    if ((key === "model" || key === "modelVersion") && typeof inner === "string") out[key] = options.publicName;
    else if (key === "error") out[key] = scrubError(maskStoredResponse(inner, options), options);
    else if (inner && typeof inner === "object") out[key] = maskStoredResponse(inner, options);
    else out[key] = inner;
  }
  return out;
}
