// Who may use the skill installer: a holder of an active customer API key.
//
// The install script runs in a terminal, where the customer has an API key and
// no browser session, so the installer endpoints authenticate with the key —
// the same one the customer already uses for the proxy. Anything that is not a
// customer key in good standing gets one generic answer, so the endpoints never
// confirm which part was wrong (unknown key, admin key, disabled, suspended).
//
// Only headers are read, never `?key=`: a key in a URL ends up in proxy logs and
// shell history.
import { getApiKeyForAuth } from "../db/repos/apiKeysRepo.js";
import { extractApiKey } from "../auth/apiKeyExtract.js";

// The same extractor the request guard uses, so a key the guard counts as an
// unknown guess is exactly the key this endpoint would try. Handing it only the
// headers keeps `?key=` out: a URL ends up in logs.
function keyFromHeaders(request) {
  return extractApiKey({ headers: request?.headers }) || null;
}

/**
 * @returns {Promise<{userId:string}|null>} null when the request is not from an
 * active customer key whose owner is active and whose key has not expired.
 */
export async function resolveSkillKey(request) {
  const apiKey = keyFromHeaders(request);
  if (!apiKey) return null;
  const auth = await getApiKeyForAuth(apiKey);
  if (!auth?.key?.userId) return null; // unknown key, or an admin key
  if (auth.key.isActive !== 1 && auth.key.isActive !== true) return null;
  if (auth.owner?.status !== "active") return null;
  const expiresAt = auth.resolved?.expiresAt;
  if (expiresAt) {
    const exp = new Date(expiresAt).getTime();
    if (Number.isFinite(exp) && Date.now() > exp) return null;
  }
  return { userId: auth.key.userId };
}

export const SKILL_KEY_DENIED = { error: "Key không hợp lệ hoặc tài khoản không còn hoạt động" };
