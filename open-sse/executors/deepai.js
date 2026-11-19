import { DefaultExecutor } from "./default.js";
import { deepaiLaneHeaders, ensureDeepAICheckIn } from "../services/deepaiClient.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "../config/errorConfig.js";

// DeepAI's own "this account is out of it" answers (app v0.3.40, session-logic: theos_exhausted,
// "Daily limit reached", "Too many requests today"). A free model has no counter to read: the
// only signal is this answer. The model is then locked on this account (the lock is per model)
// for the longest cooldown the router allows, so requests move to another account instead of
// retrying the exhausted one every few seconds. A plain 429 (heavy load) keeps the short backoff.
const DEEPAI_EXHAUSTED = /\btheos_exhausted\b|\bdaily (?:request )?limit reached\b|\btoo many requests today\b/i;

/** The upstream error as { status, message, resetsAtMs? } (exported for tests). */
export function parseDeepAIError(status, bodyText) {
  let message = bodyText || `HTTP ${status}`;
  try {
    const json = JSON.parse(bodyText);
    const m = json?.error?.message ?? json?.message ?? json?.error ?? json?.detail;
    if (typeof m === "string" && m) {
      const code = json?.error?.code ?? json?.code;
      // Keep DeepAI's code next to its text: the router's error rules and the log read it.
      message = typeof code === "string" && code && !m.includes(code) ? `${code}: ${m}` : m;
    }
  } catch { /* not JSON: keep the text */ }
  const exhausted = DEEPAI_EXHAUSTED.test(String(bodyText || "")) || DEEPAI_EXHAUSTED.test(message);
  return exhausted
    ? { status, message, resetsAtMs: Date.now() + MAX_RATE_LIMIT_COOLDOWN_MS }
    : { status, message };
}

// DeepAI Code hosted models (api.deepai.org/deepai_code): OpenAI chat format, `api-key`
// auth, and a per-account check-in renewed through GET /theos before every request. The
// registry entry carries the URL and auth header; this executor adds each account's own
// lane+machine identity. The check-in nonce and the beacon belong to /theos only — the
// desktop app never sends them on chat, so neither do we.
export class DeepAIExecutor extends DefaultExecutor {
  constructor() {
    super("deepai");
  }

  async execute(opts) {
    const key = opts?.credentials?.apiKey || opts?.credentials?.accessToken;
    await ensureDeepAICheckIn(key, opts?.proxyOptions || null, opts?.log || null);
    return super.execute(opts);
  }

  parseError(response, bodyText) {
    return parseDeepAIError(response.status, bodyText);
  }

  buildHeaders(credentials, stream = true, url, model, body = null) {
    const headers = super.buildHeaders(credentials, stream, url, model, body);
    // Lane headers carry the account's own machine/instance identity, so they are
    // derived from this request's credentials — never stashed between calls, which
    // would let two concurrent accounts receive each other's identity.
    Object.assign(headers, deepaiLaneHeaders(credentials?.apiKey || credentials?.accessToken));
    return headers;
  }
}

export default DeepAIExecutor;
