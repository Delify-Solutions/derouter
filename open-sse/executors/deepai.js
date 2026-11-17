import { DefaultExecutor } from "./default.js";
import { deepaiLaneHeaders, ensureDeepAICheckIn } from "../services/deepaiClient.js";

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
