// Low-level Telegram Bot API calls (spec telegram-notify, spec telegram-support).
// Never throws and never logs the token or the URL (the token is part of the path).
//
// Relative imports only: tests import this module directly.

const API_BASE = "https://api.telegram.org";
const TIMEOUT_MS = 8000;

/** Telegram's own ceiling for one message body. */
export const MAX_MESSAGE_LENGTH = 4096;

/**
 * Send `text` (Telegram HTML subset) to `chatId`.
 *
 * @returns {Promise<{ ok: boolean, blocked?: boolean, retryAfterSec?: number, reason?: string,
 *                     messageId?: number }>}
 *   blocked: Telegram will not deliver to this chat (bot blocked by the user, the
 *   user never allowed the bot to message them, or the chat does not exist).
 *   retryAfterSec: flood limit hit; wait that long before the next message.
 *   messageId: the sent message's Telegram id, when Telegram returned one. The
 *   support chat stores it so a later reply can point at what it answers.
 */
export async function sendTelegramMessage(token, chatId, text, { fetchImpl = fetch, replyMarkup = null } = {}) {
  if (!token || !chatId || !text) return { ok: false, reason: "not_configured" };
  let res;
  try {
    res = await fetchImpl(`${API_BASE}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: String(chatId),
        text: String(text).slice(0, MAX_MESSAGE_LENGTH),
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    console.error(`[telegram] request failed: ${error?.name === "TimeoutError" ? "timeout" : "network error"}`);
    return { ok: false, reason: "network_error" };
  }
  const body = await res.json().catch(() => ({}));
  if (res.ok) {
    const messageId = Number(body?.result?.message_id);
    return Number.isFinite(messageId) && messageId > 0 ? { ok: true, messageId } : { ok: true };
  }

  const description = String(body?.description || "").slice(0, 200);
  if (res.status === 429) {
    const retryAfterSec = Number(body?.parameters?.retry_after) || 1;
    return { ok: false, reason: "rate_limited", retryAfterSec };
  }
  // 403: blocked by the user / user is deactivated / can't initiate conversation.
  // 400 "chat not found": the user never opened a chat the bot may write to.
  if (res.status === 403 || (res.status === 400 && /chat not found/i.test(description))) {
    return { ok: false, reason: "blocked", blocked: true };
  }
  console.error(`[telegram] sendMessage responded ${res.status}${description ? `: ${description}` : ""}`);
  return { ok: false, reason: "telegram_error" };
}

/**
 * Long polling for bot updates (spec telegram-support). The bot is the same one that
 * sends notifications, so it can only have ONE reader: whoever calls this owns the
 * update stream. The offset confirms every update before it, which is what makes a
 * restart safe — no message is delivered twice.
 *
 * @param {object} options
 * @param {number} [options.offset] first update id to return (last seen + 1)
 * @param {number} [options.timeoutSec] Telegram-held long-poll window
 * @returns {Promise<{ ok: boolean, updates?: Array, offset?: number, reason?: string,
 *                     retryAfterSec?: number }>}
 *   `offset` is the next offset to use, and equals the input offset when no update
 *   arrived, so a caller can keep it across restarts.
 */
export async function getTelegramUpdates(token, {
  offset = 0,
  timeoutSec = 25,
  limit = 50,
  fetchImpl = fetch,
  signal = null,
} = {}) {
  if (!token) return { ok: false, reason: "not_configured" };
  let res;
  try {
    res = await fetchImpl(`${API_BASE}/bot${token}/getUpdates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        offset: Math.max(0, Math.floor(Number(offset) || 0)),
        // Only plain messages: the support chat does not read edits, channel posts
        // or callbacks, and asking for them would only widen what can be spoofed.
        allowed_updates: ["message"],
        limit,
        timeout: Math.max(0, Math.min(50, Math.floor(Number(timeoutSec) || 0))),
      }),
      // The long poll can legitimately take `timeoutSec`; the margin covers the
      // round trip without letting a stuck connection hold the loop forever.
      signal: signal ?? AbortSignal.timeout((Math.max(0, Number(timeoutSec) || 0) + 15) * 1000),
    });
  } catch (error) {
    console.error(`[telegram] getUpdates failed: ${error?.name === "TimeoutError" ? "timeout" : "network error"}`);
    return { ok: false, reason: "network_error" };
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 429) {
      return { ok: false, reason: "rate_limited", retryAfterSec: Number(body?.parameters?.retry_after) || 1 };
    }
    // 409 = another process is polling (a second instance, or a webhook is set).
    // 401/404 = the token is wrong or was revoked. All three are configuration
    // states the operator must resolve; retrying them every few seconds only spams
    // Telegram and fills the log.
    const reason =
      res.status === 409 ? "conflict"
        : res.status === 401 || res.status === 404 ? "invalid_token"
          : "telegram_error";
    console.error(
      `[telegram] getUpdates responded ${res.status}${
        reason === "conflict"
          ? " (another reader is polling or a webhook is set)"
          : reason === "invalid_token"
            ? " (the bot token is wrong or revoked)"
            : ""
      }`
    );
    return { ok: false, reason, status: res.status };
  }

  const updates = Array.isArray(body?.result) ? body.result : [];
  let next = Math.max(0, Math.floor(Number(offset) || 0));
  for (const update of updates) {
    const id = Number(update?.update_id);
    if (Number.isFinite(id) && id >= next) next = id + 1;
  }
  return { ok: true, updates, offset: next };
}

/** Best-effort "typing" indicator. Never throws; a failure is not worth reporting. */
export async function sendTelegramChatAction(token, chatId, action = "typing", { fetchImpl = fetch } = {}) {
  if (!token || !chatId) return { ok: false, reason: "not_configured" };
  try {
    const res = await fetchImpl(`${API_BASE}/bot${token}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: String(chatId), action }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { ok: res.ok };
  } catch {
    return { ok: false, reason: "network_error" };
  }
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
