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

/** Basis points as a Vietnamese percent number: 1000 → "10", 1250 → "12,5". */
function percentText(bp) {
  const n = Number(bp) || 0;
  return (n / 100).toFixed(2).replace(/\.?0+$/, "").replace(".", ",");
}

/**
 * What a referred visitor gets, as short Vietnamese lines (spec affiliate-program
 * "Referral popup"). `referral` = { code, bonus: { bp, maxOrders } | null,
 * giftCode | null } as resolved on the server.
 */
export function referralBenefits(referral) {
  const lines = [];
  const bp = Number(referral?.bonus?.bp) || 0;
  if (bp > 0) {
    const n = Number(referral.bonus.maxOrders) || 0;
    const scope = n === 0 ? "mọi đơn đã thanh toán" : `${n} đơn đầu đã thanh toán`;
    lines.push(`Tặng thêm ${percentText(bp)}% credit cho ${scope}.`);
    lines.push(`Gói không giới hạn credit: giảm ${percentText(bp)}% ngay khi thanh toán.`);
  }
  if (referral?.giftCode) {
    lines.push(`Mã quà chào mừng ${referral.giftCode}: liên kết Telegram rồi nhập ở trang Mã quà tặng.`);
  }
  return lines;
}

/**
 * The popup a visitor sees: the promotional popup, the referral announcement, or
 * both merged into ONE dialog (never two stacked). Null when there is nothing to
 * show. A referral version differs from the plain promo version, so closing one
 * does not hide the other.
 */
export function combinePopup(copy = {}, referral = null) {
  const promo = readPromoPopup(copy);
  const promoLive = promo.enabled && Boolean(promo.title || promo.body || promo.code);
  const benefits = referral?.code ? referralBenefits(referral) : [];
  // A referral that gives the visitor nothing (no buyer bonus, no welcome gift)
  // is not announced: an empty "you are invited" dialog would promise offers
  // that do not exist, and would re-open a promo the visitor already closed.
  if (benefits.length === 0) return promoLive ? promo : null;
  return {
    enabled: true,
    title: promoLive && promo.title ? promo.title : "Bạn được mời dùng thử",
    body: promoLive ? promo.body : "",
    code: promoLive ? promo.code : "",
    cta: promoLive ? promo.cta : "Đăng ký nhận ưu đãi",
    // Shown sooner than a plain promo: the visitor came through the link for it.
    delaySec: promoLive ? Math.min(promo.delaySec, 1) : 1,
    repeatMinutes: promo.repeatMinutes,
    referral: {
      code: referral.code,
      benefits,
      giftCode: referral.giftCode || null,
    },
    version: hashText(`${promo.version}|ref:${referral.code}|${benefits.join("|")}`),
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
export function promoTargetHref(code, { signedIn = false, refCode = null } = {}) {
  const key = normalizePromoCode(code);
  // A referred visitor registers with the referral code, so the register page
  // shows its banner even if the cookie was blocked.
  const ref = normalizePromoCode(refCode);
  const params = new URLSearchParams();
  if (ref) params.set("ref", ref);
  if (!key) {
    if (signedIn) return "/account";
    return params.toString() ? `/register?${params}` : "/register";
  }
  const gift = giftPageHref(key);
  if (signedIn) return gift;
  params.set("next", gift);
  return `/register?${params}`;
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
