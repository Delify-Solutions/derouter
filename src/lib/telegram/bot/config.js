// Command-bot settings (change telegram-bot-commands). Dependency-free.
import crypto from "node:crypto";

/** The address links in bot replies point at: the public base URL, else the one saved when the bot was enabled. */
export function botBaseUrlOf(settings) {
  const pick = [settings?.publicBaseUrl, settings?.telegramBotBaseUrl]
    .map((value) => (typeof value === "string" ? value.trim().replace(/\/+$/, "") : ""))
    .find(Boolean);
  return pick || "";
}

/** An https origin the admin typed, normalised ("" when invalid). */
export function normalizeBaseUrl(raw) {
  try {
    const url = new URL(String(raw || "").trim());
    if (url.protocol !== "https:") return "";
    return url.origin;
  } catch {
    return "";
  }
}

export function newWebhookSecret() {
  return crypto.randomBytes(32).toString("hex");
}

/** Constant-time compare of the secret header Telegram sends with every update. */
export function webhookSecretMatches(expected, given) {
  if (typeof expected !== "string" || expected.length < 32 || typeof given !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Validate the admin's list of Telegram ids. @returns {{ value: string[] } | { error: string }} */
export function normalizeAdminIds(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? "").split(/[\s,;]+/);
  const ids = list.map((id) => String(id).trim()).filter(Boolean);
  if (ids.some((id) => !/^\d{1,20}$/.test(id))) return { error: "Telegram ID admin chỉ gồm chữ số, cách nhau bằng dấu phẩy" };
  if (ids.length > 20) return { error: "Tối đa 20 Telegram ID admin" };
  return { value: [...new Set(ids)] };
}
