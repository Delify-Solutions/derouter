import { getApiKeys, createApiKey } from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";

export const CHAT_KEY_NAME = "Web chat";

/**
 * The customer's own API key used by the web chat, or null when chat is switched off
 * for them.
 *
 * The chat does not get a session-only shortcut: it calls the same `/v1` handlers
 * with a real key owned by the customer, so group, plan limits, expiry, admission
 * and credit charging apply exactly as they do for any API request. The key is a
 * normal row in their key list (named "Web chat") that they can delete; it is created
 * on first use and recreated if they delete it. A "Web chat" key that exists but is
 * inactive means an admin turned chat off for this account, so it is NOT replaced.
 */
export async function ensureChatKey(userId) {
  const keys = await getApiKeys();
  const mine = keys.find((key) => key.userId === userId && key.name === CHAT_KEY_NAME);
  if (mine) return mine.isActive && mine.key ? mine.key : null;

  const machineId = await getConsistentMachineId();
  const created = await createApiKey(CHAT_KEY_NAME, machineId, { userId });
  return created.key;
}
