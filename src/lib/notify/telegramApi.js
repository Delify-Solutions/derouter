// Low-level Telegram Bot API sendMessage (spec telegram-notify). Never throws and
// never logs the token or the URL (the token is part of the path).
//
// Relative imports only: tests import this module directly.

const API_BASE = "https://api.telegram.org";
const TIMEOUT_MS = 8000;

/**
 * Send `text` (Telegram HTML subset) to `chatId`.
 *
 * @returns {Promise<{ ok: boolean, blocked?: boolean, retryAfterSec?: number, reason?: string }>}
 *   blocked: Telegram will not deliver to this chat (bot blocked by the user, the
 *   user never allowed the bot to message them, or the chat does not exist).
 *   retryAfterSec: flood limit hit; wait that long before the next message.
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
        text: String(text).slice(0, 4096),
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
  if (res.ok) return { ok: true };

  const body = await res.json().catch(() => ({}));
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

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
