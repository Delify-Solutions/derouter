import { DEEPAI_CONFIG } from "../constants/oauth.js";
import {
  buildDeepAISignInUrl,
  exchangeDeepAICode,
  mapDeepAITokens,
  newDeepAIState,
} from "open-sse/services/deepaiAuth.js";

// DeepAI Code — browser sign-in that ends on a loopback callback carrying a one-time
// code. The hosted dashboard cannot receive 127.0.0.1, so the admin pastes the callback
// URL; the code is exchanged for a long-lived api_key stored as the connection's
// accessToken (protocol details live in open-sse/services/deepaiAuth.js).
const deepai = {
  config: DEEPAI_CONFIG,
  flowType: "authorization_code",
  callbackPath: DEEPAI_CONFIG.callbackPath || "/auth-callback",
  // generateAuthData takes `loginTraceID` as the state when a provider supplies one.
  prepareConfig: async (config) => ({ ...config, loginTraceID: newDeepAIState() }),
  buildAuthUrl: (config, redirectUri, state) => buildDeepAISignInUrl(config, redirectUri, state),
  exchangeToken: (config, code) => exchangeDeepAICode(config, code),
  mapTokens: (tokens) => mapDeepAITokens(tokens),
};

export default deepai;
