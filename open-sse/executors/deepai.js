import { DefaultExecutor } from "./default.js";
import {
  DEEPAI_CHECK_IN_HEADER,
  DEEPAI_BEACON_HEADER,
  currentCheckInNonce,
  deepaiBeacon,
  deepaiLaneHeaders,
  ensureDeepAICheckIn,
} from "../services/deepaiClient.js";

// DeepAI Code hosted models (api.deepai.org/deepai_code): OpenAI chat format, `api-key`
// auth, and a per-account check-in nonce renewed through GET /theos. The registry entry
// carries the URL and auth header; this executor adds the lane/machine/check-in headers.
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
    const key = credentials?.apiKey || credentials?.accessToken;
    Object.assign(headers, this._laneHeaders);
    headers[DEEPAI_BEACON_HEADER] = deepaiBeacon();
    const nonce = currentCheckInNonce(key);
    if (nonce) headers[DEEPAI_CHECK_IN_HEADER] = nonce;
    return headers;
  }
}

export default DeepAIExecutor;
