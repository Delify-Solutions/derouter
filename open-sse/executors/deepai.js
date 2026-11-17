import { DefaultExecutor } from "./default.js";
import { deepaiLaneHeaders, ensureDeepAICheckIn } from "../services/deepaiClient.js";

// DeepAI Code hosted models (api.deepai.org/deepai_code): OpenAI chat format, `api-key`
// auth, and a per-account check-in renewed through GET /theos before every request. The
// registry entry carries the URL and auth header; this executor adds lane+machine. The
// check-in nonce and the beacon belong to /theos only — the desktop app never sends them
// on chat, so neither do we.
export class DeepAIExecutor extends DefaultExecutor {
  constructor() {
    super("deepai");
    this._laneHeaders = {};
  }

  async execute(opts) {
    const key = opts?.credentials?.apiKey || opts?.credentials?.accessToken;
    // Lane + machine headers are the same for every account on this deployment; resolved
    // here because the machine digest is async and buildHeaders is not.
    this._laneHeaders = await deepaiLaneHeaders();
    await ensureDeepAICheckIn(key, opts?.proxyOptions || null, opts?.log || null);
    return super.execute(opts);
  }

  buildHeaders(credentials, stream = true, url, model, body = null) {
    const headers = super.buildHeaders(credentials, stream, url, model, body);
    Object.assign(headers, this._laneHeaders);
    return headers;
  }
}

export default DeepAIExecutor;
