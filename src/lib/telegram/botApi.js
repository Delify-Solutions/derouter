// Generic Telegram Bot API call for the command bot (change telegram-bot-commands).
// Never throws, never logs the token or the URL (the token is part of the path).
// Relative imports only: tests import this module directly.

const API_BASE = "https://api.telegram.org";
const TIMEOUT_MS = 8000;

/**
 * POST `method` with a JSON payload.
 * @returns {Promise<{ ok: boolean, result?: any, status?: number, description?: string }>}
 */
export async function callBotApi(token, method, payload = {}, { fetchImpl = fetch } = {}) {
  if (!token || !method) return { ok: false, description: "not_configured" };
  let res;
  try {
    res = await fetchImpl(`${API_BASE}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    console.error(`[telegram] ${method} failed: ${error?.name === "TimeoutError" ? "timeout" : "network error"}`);
    return { ok: false, description: "network_error" };
  }
  const body = await res.json().catch(() => ({}));
  if (res.ok && body?.ok) return { ok: true, result: body.result, status: res.status };
  const description = String(body?.description || "").slice(0, 200);
  // "message is not modified" is the normal answer to a repeated button press.
  if (!/message is not modified/i.test(description)) {
    console.error(`[telegram] ${method} responded ${res.status}${description ? `: ${description}` : ""}`);
  }
  return { ok: false, status: res.status, description };
}

const TEXT_MAX = 4096;

/**
 * Keep a reply inside Telegram's limit. Replies are built line by line with each
 * tag closed on its own line, so cutting at a line break never splits a tag or an
 * HTML entity (cutting the raw string could, and Telegram then rejects it all).
 */
export function fitText(text) {
  const value = String(text ?? "");
  if (value.length <= TEXT_MAX) return value;
  const cut = value.lastIndexOf("\n", TEXT_MAX - 2);
  return `${value.slice(0, cut > 0 ? cut : TEXT_MAX - 2)}\n…`;
}

/**
 * The three calls the command handler makes, bound to one token. Text is
 * Telegram HTML; `markup` an inline keyboard ({ inline_keyboard }).
 */
export function botClient(token, { fetchImpl = fetch } = {}) {
  const call = (method, payload) => callBotApi(token, method, payload, { fetchImpl });
  return {
    send: (chatId, text, markup = null) => call("sendMessage", {
      chat_id: String(chatId),
      text: fitText(text),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(markup ? { reply_markup: markup } : {}),
    }),
    edit: (chatId, messageId, text, markup = null) => call("editMessageText", {
      chat_id: String(chatId),
      message_id: messageId,
      text: fitText(text),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(markup ? { reply_markup: markup } : {}),
    }),
    answer: (callbackQueryId, text = "") => call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text: String(text).slice(0, 200) } : {}),
    }),
  };
}
