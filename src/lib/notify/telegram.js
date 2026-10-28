import { getSettings } from "@/lib/localDb";
import { fmtUsdNano } from "@/shared/utils/money";

// Admin notifications over the Telegram Bot API. Never throws: a missing token,
// a network failure or a 4xx from Telegram must never break the request that
// triggered the notification (registration, order creation, a settings test).

const API_BASE = "https://api.telegram.org";
const TIMEOUT_MS = 8000;

async function loadTelegramSettings() {
  try {
    return (await getSettings()) || {};
  } catch {
    return {};
  }
}

/**
 * Send `text` (Telegram HTML subset) to the configured admin chat.
 * Returns `{ ok, reason? }`; `reason` is "not_configured" | "telegram_error" | "network_error".
 */
export async function notifyAdmin(text) {
  if (!text || typeof text !== "string") return { ok: false, reason: "not_configured" };

  const settings = await loadTelegramSettings();
  const token = typeof settings.telegramBotToken === "string" ? settings.telegramBotToken.trim() : "";
  const chatId = typeof settings.telegramChatId === "string" ? settings.telegramChatId.trim() : "";
  if (!token || !chatId) return { ok: false, reason: "not_configured" };

  try {
    const res = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[notify] telegram responded ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
      return { ok: false, reason: "telegram_error" };
    }
    return { ok: true };
  } catch (error) {
    console.error(`[notify] telegram request failed: ${error?.message || "unknown error"}`);
    return { ok: false, reason: "network_error" };
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function notifyAdminNewUser({ email, groupId, siteName } = {}) {
  const label = siteName ? `${escapeHtml(siteName)} — ` : "";
  const group = groupId ? `<code>${escapeHtml(groupId)}</code>` : "none";
  return notifyAdmin(
    `${label}<b>New user</b>\n<code>${escapeHtml(email || "(no email)")}</code>\ngroup: ${group}`
  );
}


/**
 * Thin wrapper so order code (owned by another task) can announce sales without
 * importing this module's internals.
 */
export async function notifyAdminNewOrder({ email, planName, amountNanoUsd, status, method, orderId } = {}) {
  const lines = [`<b>New order</b>${status ? ` (${escapeHtml(status)})` : ""}`];
  if (email) lines.push(`user: <code>${escapeHtml(email)}</code>`);
  if (planName) lines.push(`plan: ${escapeHtml(planName)}`);
  if (amountNanoUsd != null) lines.push(`amount: <code>${escapeHtml(fmtUsdNano(amountNanoUsd))}</code>`);
  if (method) lines.push(`method: ${escapeHtml(method)}`);
  if (orderId) lines.push(`order: <code>${escapeHtml(orderId)}</code>`);
  return notifyAdmin(lines.join("\n"));
}
