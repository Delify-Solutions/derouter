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

export const BOT_CHAT_KEY_NAME = "Chat thử";

/**
 * The per-bot key the business playground uses. It is a normal bot key owned by the
 * customer, so the playground is billed, rate-limited and guarded exactly like the
 * public API (spec business-bots "Playground"). It is hidden from the bot's key
 * list because it exists for the console, not for the customer to copy.
 *
 * A key that exists but is inactive means an admin turned it off; like the web chat
 * key it is NOT silently replaced.
 */
export async function ensureBotChatKey(userId, botId) {
  const keys = await getApiKeys();
  const mine = keys.find(
    (key) => key.userId === userId && key.botId === botId && key.name === BOT_CHAT_KEY_NAME
  );
  if (mine) return mine.isActive && mine.key ? mine.key : null;

  const machineId = await getConsistentMachineId();
  const created = await createApiKey(BOT_CHAT_KEY_NAME, machineId, { userId, botId });
  return created.key;
}
