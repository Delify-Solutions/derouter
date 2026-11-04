// Promotional popup on the landing page (spec promo-popup): reading its settings
// from the landing copy, where its button leads, and the "pending gift code" a
// visitor carries from the popup through sign-up to the gift page.
//
// Pure module with relative imports only: the landing page, the admin editor,
// the register form and the gift page import it client-side, tests under Node.

export const DEFAULT_DELAY_SEC = 3;
// Closing the popup only hides it for a short while (owner request: it must keep
// coming back, not vanish for days). 0 = show again on every page load.
export const DEFAULT_REPEAT_MINUTES = 5;
export const MAX_DELAY_SEC = 120;
export const MAX_REPEAT_MINUTES = 7 * 24 * 60;

/** localStorage key holding `{ code, at }` between the popup and the gift page. */
export const PENDING_GIFT_KEY = "derouter:pendingGiftCode";
/** localStorage key holding `{ version, at }` for the last dismissal. */
export const POPUP_DISMISS_KEY = "derouter:promoPopupDismissed";
/** A pending code older than this is forgotten: the visitor moved on. */
export const PENDING_GIFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Lengths the popup is designed for; longer text would not fit the dialog. */
export const POPUP_LIMITS = { popupTitle: 120, popupBody: 600, popupCode: 64, popupCta: 40 };

/**
 * Vietnamese error for an invalid popup field in an admin save, or null. Only
 * popup keys are checked; any other key returns null.
 */
export function popupFieldError(key, value) {
  const text = String(value ?? "");
  if (POPUP_LIMITS[key] && text.length > POPUP_LIMITS[key]) {
    return `Popup: tối đa ${POPUP_LIMITS[key]} ký tự cho trường này`;
  }
  if (key === "popupCode" && text.trim() && !/^[A-Za-z0-9-]+$/.test(text.trim())) {
    return "Popup: mã chỉ gồm chữ, số và dấu gạch ngang";
  }
  if (key === "popupDelaySec" || key === "popupRepeatMinutes") {
    const max = key === "popupDelaySec" ? MAX_DELAY_SEC : MAX_REPEAT_MINUTES;
    const trimmed = text.trim();
    if (trimmed && (!/^\d+$/.test(trimmed) || Number(trimmed) > max)) {
      return key === "popupDelaySec"
        ? `Popup: thời gian chờ là số giây từ 0 đến ${max}`
        : `Popup: số phút hiện lại là số từ 0 đến ${max}`;
    }
  }
  return null;
}

/** Value stored for a popup key: the code trimmed and upper-cased, the rest as typed. */
export function storedPopupValue(key, value) {
  return key === "popupCode" ? String(value ?? "").trim().toUpperCase() : value;
}

/** Gift code as the redeem API compares it: upper case, letters and digits only. */
export function normalizePromoCode(input) {
  return String(input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 64);
}

function boundedInt(raw, fallback, max) {
  const n = Number(String(raw ?? "").trim());
  if (!Number.isFinite(n) || String(raw ?? "").trim() === "") return fallback;
  return Math.min(max, Math.max(0, Math.round(n)));
}

// Short stable hash so a dismissal is tied to the content it dismissed: editing
// the popup shows it again to visitors who closed the previous one.
function hashText(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Popup settings from the landing copy, with defaults applied. */
export function readPromoPopup(copy = {}) {
  const title = String(copy.popupTitle ?? "").trim();
  const body = String(copy.popupBody ?? "").trim();
  const code = String(copy.popupCode ?? "").trim().toUpperCase();
  const cta = String(copy.popupCta ?? "").trim();
  return {
    enabled: Boolean(copy.popupEnabled),
    title,
    body,
    code,
    cta: cta || (code ? "Đăng ký nhận ưu đãi" : "Đăng ký ngay"),
    delaySec: boundedInt(copy.popupDelaySec, DEFAULT_DELAY_SEC, MAX_DELAY_SEC),
    repeatMinutes: boundedInt(copy.popupRepeatMinutes, DEFAULT_REPEAT_MINUTES, MAX_REPEAT_MINUTES),
    version: hashText(`${title}\n${body}\n${code}\n${cta}`),
  };
}

/** "live" | "disabled" | "empty": the same rule the landing page applies. */
export function promoPopupState(copy) {
  const popup = readPromoPopup(copy);
  if (!popup.enabled) return "disabled";
  if (!popup.title && !popup.body && !popup.code) return "empty";
  return "live";
}

/** Gift page URL with the code prefilled. */
export function giftPageHref(code) {
  const key = normalizePromoCode(code);
  return key ? `/account/gift?code=${encodeURIComponent(key)}` : "/account/gift";
}

/**
 * Where the popup's button leads: a signed-in customer goes straight to the gift
 * page; a visitor registers first and lands there afterwards (register honours
 * a safe `next`). Without a code the button is a plain sign-up.
 */
export function promoTargetHref(code, { signedIn = false } = {}) {
  const key = normalizePromoCode(code);
  if (!key) return signedIn ? "/account" : "/register";
  const gift = giftPageHref(key);
  return signedIn ? gift : `/register?next=${encodeURIComponent(gift)}`;
}

/**
 * True when a dismissal of this popup version is still in force: closed less
 * than `repeatMinutes` ago. 0 = never in force (shown on every page load).
 */
export function isPopupDismissed(record, version, repeatMinutes, now = Date.now()) {
  if (!record || record.version !== version) return false;
  const at = Number(record.at);
  if (!Number.isFinite(at)) return false;
  if (repeatMinutes <= 0) return false;
  return now - at < repeatMinutes * 60 * 1000;
}

// ── Browser storage (every access guarded: private mode and blocked storage throw) ──

function storage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function readJson(key) {
  try {
    const raw = storage()?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: the URL still carries the code */
  }
}

export function savePendingGiftCode(code, now = Date.now()) {
  const key = normalizePromoCode(code);
  if (key) writeJson(PENDING_GIFT_KEY, { code: key, at: now });
}

/** The code the visitor picked up from the popup, if still fresh. */
export function readPendingGiftCode(now = Date.now()) {
  const record = readJson(PENDING_GIFT_KEY);
  const code = normalizePromoCode(record?.code);
  const at = Number(record?.at);
  if (!code || !Number.isFinite(at) || now - at > PENDING_GIFT_TTL_MS) return "";
  return code;
}

export function clearPendingGiftCode() {
  try {
    storage()?.removeItem(PENDING_GIFT_KEY);
  } catch {
    /* ignore */
  }
}

export function readPopupDismissal() {
  return readJson(POPUP_DISMISS_KEY);
}

export function savePopupDismissal(version, now = Date.now()) {
  writeJson(POPUP_DISMISS_KEY, { version, at: now });
}
