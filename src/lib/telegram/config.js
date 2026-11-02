import { getSettings } from "@/lib/localDb";

/**
 * Mini App settings for account linking (spec telegram-link). The bot token is
 * returned for server-side signature checks only; never send it to a client.
 */
export async function loadTelegramLinkConfig() {
  let settings = {};
  try {
    settings = (await getSettings()) || {};
  } catch {
    settings = {};
  }
  const botToken = typeof settings.telegramBotToken === "string" ? settings.telegramBotToken.trim() : "";
  const botUsername = typeof settings.telegramBotUsername === "string"
    ? settings.telegramBotUsername.trim().replace(/^@/, "")
    : "";
  const appName = (typeof settings.telegramMiniAppName === "string" && settings.telegramMiniAppName.trim()) || "link";
  return {
    botToken,
    botUsername,
    appName,
    configured: Boolean(botToken && /^[A-Za-z0-9_]{3,64}$/.test(botUsername) && /^[A-Za-z0-9_]{1,64}$/.test(appName)),
  };
}

export const NOT_CONFIGURED_TEXT = "Hệ thống chưa cấu hình liên kết Telegram. Vui lòng liên hệ admin.";
