// Shared transport for provider fetchers (design D2).
//
// Every provider needs the same four things: a 15 s timeout, a JSON decode that
// never throws, an error message that cannot leak a URL/header/secret, and a
// shape (`{ ok, transactions } | { ok:false, error }`) the poller can store on the
// provider row verbatim.
//
// SECRETS — two layers, in this order and for this reason:
//
//   1. VALUE redaction. Every fetcher passes the plaintext credentials it holds to
//      `redactValues()`, which replaces each exact occurrence with `[redacted]`.
//      This is the only layer that can be trusted: it does not care whether the
//      text says "key", "apikey", "authorization" or nothing at all, so
//      `key=ABC`, `auth=undefined key=ABC` and `{"msg":"bad key ABC"}` are all
//      caught because ABC itself is known.
//   2. LABEL redaction, as a second pass for a credential that is NOT in scope
//      (a header we never built, a body echoing something we do not know).
//
// The order is not cosmetic. Running the label pass first lets it consume part of
// a credential (`Bearer ABC` → `[redacted]` leaves nothing for the exact match to
// find if the value was quoted differently), and it can also split a value so the
// remainder no longer matches. Value first, always.
//
// Relative imports only: `node --test` loads this module directly.

export const REQUEST_TIMEOUT_MS = 15_000;

/** What a redacted credential looks like in a stored error / a log line. */
const REDACTED = "[redacted]";

// Second-layer patterns for unknown credentials. Deliberately broad: a false
// positive costs a redacted word, a false negative leaks a credential.
const LABEL_PATTERNS = [
  // `key=…`, `apikey: …`, `token = …` — including bare `key`, which is the shape
  // most APIs actually echo back.
  /\b(?:api[_-]?key|apikey|secret|token|password|passwd|pass|signature|authorization|auth|bearer|key)\b\s*[:=]\s*\S+/gi,
  /\bApikey\s+\S+/gi,
  /\bBearer\s+\S+/gi,
  // Any URL: it may carry a token in its path or query (web2m's whole API).
  /https?:\/\/[^\s"'<>]+/gi,
];

/**
 * Replace every occurrence of the given credential VALUES with `[redacted]`.
 *
 * Exported separately from `sanitizeMessage` so a caller composing a message by
 * hand (`${provider.kind}: ${error}`) can apply it without the label pass.
 *
 * Ordering inside this function: longest value first, so a secret that contains
 * another secret is fully removed rather than leaving the outer secret's tail.
 *
 * @param {string} text
 * @param {Iterable<unknown>} values plaintext credentials currently in scope
 * @returns {string}
 */
export function redactValues(text, values) {
  if (typeof text !== "string" || !text) return "";
  // Accept either the plaintext list or the provider's `secrets` object: a caller
  // holding the record should not have to know which shape this wants.
  const source = values && typeof values === "object" && !Array.isArray(values) && typeof values[Symbol.iterator] !== "function"
    ? secretValues(values)
    : (values ?? []);
  const list = [];
  for (const value of source) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    // A very short "secret" would redact ordinary words and make errors useless.
    // Real credentials are longer; 6 is the floor that keeps `[redacted]` honest
    // while still catching a short test key.
    if (trimmed.length < 6) continue;
    list.push(trimmed);
  }
  // Also redact the URL-encoded form: a token in a query string may arrive
  // escaped (`%40` for `@`), and the raw form would then survive untouched.
  const expanded = [];
  for (const value of list) {
    expanded.push(value);
    const encoded = encodeURIComponent(value);
    if (encoded !== value) expanded.push(encoded);
  }
  expanded.sort((a, b) => b.length - a.length);

  let out = text;
  for (const value of expanded) out = out.split(value).join(REDACTED);
  return out;
}

/**
 * Remove credentials and URLs from text intended for storage or display.
 *
 * @param {unknown} value
 * @param {number|{maxLength?: number, secrets?: Iterable<unknown>}} [options]
 *   Either the legacy numeric length, or `{ maxLength, secrets }`. Callers that
 *   hold the provider's plaintext secrets MUST pass them.
 * @returns {string}
 */
export function sanitizeMessage(value, options = 300) {
  const maxLength = typeof options === "number" ? options : (options?.maxLength ?? 300);
  const secrets = typeof options === "object" && options ? options.secrets : null;

  if (value == null) return "";
  let text = typeof value === "string" ? value : safeStringify(value);

  // Layer 1 — exact values. Runs FIRST (see the header comment).
  if (secrets) text = redactValues(text, secrets);
  // Layer 2 — labels, for anything not in scope.
  for (const pattern of LABEL_PATTERNS) text = text.replace(pattern, REDACTED);

  text = text.replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/**
 * The credential values a provider's record carries, for `redactValues`.
 *
 * One place so every fetcher redacts the same things: a provider that forgets one
 * secret is exactly how NC-1 happened.
 *
 * @param {object} secrets the provider's decrypted `secrets` object
 * @returns {string[]}
 */
export function secretValues(secrets = {}) {
  if (!secrets || typeof secrets !== "object") return [];
  const out = [];
  for (const value of Object.values(secrets)) {
    if (typeof value === "string" && value) out.push(value);
  }
  // The proxy URL carries credentials in its userinfo, so its password alone must
  // be redacted too — `new URL` on a malformed string would throw, hence the split.
  const proxy = typeof secrets.proxyUrl === "string" ? secrets.proxyUrl : "";
  if (proxy) {
    const match = /^[a-z][a-z0-9+.-]*:\/\/(?:([^:@/]*):)?([^@/]*)@/i.exec(proxy);
    if (match?.[2]) out.push(match[2]);
  }
  return out;
}

/** A provider's own `message`/`error` field, sanitized and capped. Never a whole body. */
export function providerMessage(body, keys = ["message", "error", "msg", "description"], secrets = null) {
  if (!body || typeof body !== "object") return "";
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) return sanitizeMessage(value, { secrets });
  }
  return "";
}

/**
 * `fetch` with the 15 s timeout the spec requires. Returns the raw Response or a
 * reason string; the reason never contains the URL.
 */
export async function fetchWithTimeout(fetchImpl, url, init = {}) {
  const impl = typeof fetchImpl === "function" ? fetchImpl : globalThis.fetch;
  if (typeof impl !== "function") return { ok: false, error: "không có fetch" };
  try {
    // 15 s ceiling for every provider call: the poller tick must finish well
    // inside its interval, and a hung bank API must not hold a provider forever.
    const signal = init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await impl(url, { ...init, signal });
    return { ok: true, response };
  } catch (error) {
    const name = error?.name || "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { ok: false, error: "hết thời gian chờ" };
    }
    return { ok: false, error: "không kết nối được" };
  }
}

/** Parse a Response body as JSON, returning null instead of throwing. */
export async function readJson(response) {
  if (!response) return null;
  try {
    if (typeof response.json === "function") return await response.json();
    if (typeof response.text === "function") {
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** Parse a Response body as text, returning "" instead of throwing. */
export async function readText(response) {
  if (!response) return "";
  try {
    if (typeof response.text === "function") return await response.text();
  } catch {
    // fall through
  }
  return "";
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
