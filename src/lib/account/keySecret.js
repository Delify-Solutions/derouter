// The secret of one of a customer's own keys, for POST /api/account/keys/{id}/secret.
// Relative imports only: tests import this under plain `node --test`.
import { getApiKeyById } from "../db/repos/apiKeysRepo.js";

/**
 * The raw key when `keyId` names a key owned by `userId`, else null. A key of
 * another customer, an admin key (no owner) and an unknown id all give null, so
 * the route answers the same 404 for each and the id space reveals nothing.
 *
 * @param {string} userId
 * @param {string} keyId
 * @returns {Promise<string|null>}
 */
export async function getOwnedKeySecret(userId, keyId) {
  if (!userId || !keyId) return null;
  const key = await getApiKeyById(keyId);
  if (!key || !key.userId || key.userId !== userId) return null;
  return typeof key.key === "string" && key.key ? key.key : null;
}
