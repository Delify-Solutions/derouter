// The admin's public Telegram channel link (change models-notifications, D6).
// Dependency-free so tests and client code can import it.

const MAX_LENGTH = 200;

/**
 * Normalise an admin-entered channel link to `https://t.me/<path>`.
 * Accepts `https://t.me/x`, `http://t.me/x`, `t.me/x`, `telegram.me/x` and `@x`.
 * @returns {{ value: string } | { error: string }} `value` "" clears the link
 */
export function normalizeChannelUrl(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { value: "" };
  if (text.length > MAX_LENGTH) return { error: `Link kênh Telegram tối đa ${MAX_LENGTH} ký tự` };
  let path = null;
  if (/^@[A-Za-z0-9_]{4,64}$/.test(text)) {
    path = text.slice(1);
  } else {
    const m = text.match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z0-9_+/=-]+)\/?$/i);
    if (m) path = m[1];
  }
  if (!path) return { error: "Link kênh Telegram phải có dạng https://t.me/ten_kenh" };
  return { value: `https://t.me/${path.replace(/\/+$/, "")}` };
}

/** The saved link, re-checked on the way out ("" when unset or invalid). */
export function channelUrlOf(settings) {
  const checked = normalizeChannelUrl(settings?.telegramChannelUrl);
  return checked.value || "";
}
