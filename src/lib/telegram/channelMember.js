// Telegram channel membership check for channel-join gift codes (change
// channel-gift). Uses Bot API getChatMember: the bot must be an administrator
// of the channel, or Telegram refuses to list its members.
//
// Never throws, never logs the token or the URL (the token is part of the path).
// Relative imports only: tests import this module directly.
import { channelUrlOf } from "./channel.js";

const API_BASE = "https://api.telegram.org";
const TIMEOUT_MS = 8000;
const CHAT_ID_RE = /^(@[A-Za-z0-9_]{4,64}|-100\d{5,20})$/;

/**
 * Normalise the admin's "chat id for membership checks": `@name`, a bare
 * `name`, or a numeric `-100…` id. "" clears it.
 * @returns {{ value: string } | { error: string }}
 */
export function normalizeChannelChatId(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { value: "" };
  const value = /^[A-Za-z0-9_]{4,64}$/.test(text) ? `@${text}` : text;
  if (!CHAT_ID_RE.test(value)) {
    return { error: "ID kênh phải có dạng @ten_kenh hoặc -100xxxxxxxxxx" };
  }
  return { value };
}

/**
 * The chat the bot checks: the explicit setting, else the public channel link's
 * username (`https://t.me/name` → `@name`). A private invite link (`t.me/+…`)
 * has no username, so it needs the explicit id. "" = cannot check.
 */
export function channelChatIdOf(settings) {
  const explicit = normalizeChannelChatId(settings?.telegramChannelChatId);
  if (explicit.value) return explicit.value;
  const url = channelUrlOf(settings);
  const m = url.match(/^https:\/\/t\.me\/([A-Za-z0-9_]{4,64})$/);
  return m ? `@${m[1]}` : "";
}

/** Bot token from settings, trimmed ("" when unset). */
export function botTokenOf(settings) {
  return typeof settings?.telegramBotToken === "string" ? settings.telegramBotToken.trim() : "";
}

/**
 * Can channel-join codes be checked at all: a bot token and a chat to ask about.
 * Codes are neither listed nor offered without it (they could only fail).
 */
export function channelCheckConfigured(settings) {
  return Boolean(botTokenOf(settings) && channelChatIdOf(settings));
}

// Per-account spacing of Bot API membership checks: a customer looping on the
// redeem button must not push the shared bot into Telegram's flood limit. In
// memory, per process; bounded.
const CHECK_SPACING_MS = 3000;
const lastCheckAt = new Map();

/**
 * Reserve a membership check for `key` (the account). false = asked too soon.
 * `spacingMs` 0 disables it (tests).
 */
export function reserveMembershipCheck(key, { now = Date.now(), spacingMs = CHECK_SPACING_MS } = {}) {
  if (!key || spacingMs <= 0) return true;
  const last = lastCheckAt.get(key);
  if (last != null && now - last < spacingMs) return false;
  if (lastCheckAt.size >= 5000) {
    for (const [k, at] of lastCheckAt) if (now - at >= spacingMs) lastCheckAt.delete(k);
    if (lastCheckAt.size >= 5000) lastCheckAt.clear();
  }
  lastCheckAt.set(key, now);
  return true;
}

const MEMBER_STATUSES = new Set(["creator", "administrator", "member"]);

/**
 * Is `telegramUserId` a member of `chatId`?
 *
 * @returns {Promise<{ ok: true, member: boolean }
 *   | { ok: false, reason: "not_configured" | "chat_unavailable" | "rate_limited" | "network_error" | "telegram_error" }>}
 *   chat_unavailable: the chat does not exist or the bot may not read its
 *   members (not an admin of the channel). The admin must fix the setup.
 */
export async function checkChannelMember(token, chatId, telegramUserId, { fetchImpl = fetch } = {}) {
  if (!token || !chatId || !telegramUserId) return { ok: false, reason: "not_configured" };
  let res;
  try {
    res = await fetchImpl(`${API_BASE}/bot${token}/getChatMember`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: String(chatId), user_id: Number(telegramUserId) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    console.error(`[telegram] getChatMember failed: ${error?.name === "TimeoutError" ? "timeout" : "network error"}`);
    return { ok: false, reason: "network_error" };
  }
  const body = await res.json().catch(() => ({}));
  if (res.ok && body?.ok) {
    const member = body.result || {};
    if (MEMBER_STATUSES.has(member.status)) return { ok: true, member: true };
    // A restricted user may still be in the chat.
    if (member.status === "restricted") return { ok: true, member: member.is_member === true };
    return { ok: true, member: false };
  }
  const description = String(body?.description || "").slice(0, 200);
  if (res.status === 429) return { ok: false, reason: "rate_limited" };
  // The user never met the chat: not a member.
  if (res.status === 400 && /user not found|participant_id_invalid|user_id_invalid/i.test(description)) {
    return { ok: true, member: false };
  }
  if (res.status === 400 || res.status === 403) {
    console.error(`[telegram] getChatMember responded ${res.status}${description ? `: ${description}` : ""}`);
    return { ok: false, reason: "chat_unavailable" };
  }
  console.error(`[telegram] getChatMember responded ${res.status}${description ? `: ${description}` : ""}`);
  return { ok: false, reason: "telegram_error" };
}

/**
 * Can the bot read the channel's members? For the admin's "Kiểm tra" button.
 * The bot's own id is the token's prefix before ":".
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function checkBotCanReadChannel(token, chatId, { fetchImpl = fetch } = {}) {
  const botId = String(token || "").split(":")[0];
  if (!/^\d+$/.test(botId) || !chatId) return { ok: false, reason: "not_configured" };
  let res;
  try {
    res = await fetchImpl(`${API_BASE}/bot${token}/getChatMember`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: String(chatId), user_id: Number(botId) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "network_error" };
  }
  const body = await res.json().catch(() => ({}));
  if (res.ok && body?.ok) {
    const status = body.result?.status;
    return status === "administrator" || status === "creator" ? { ok: true } : { ok: false, reason: "bot_not_admin" };
  }
  if (res.status === 401 || res.status === 404) return { ok: false, reason: "bad_token" };
  return { ok: false, reason: res.status === 429 ? "rate_limited" : "chat_unavailable" };
}
