// Affiliate program settings: defaults, ranges, validation and a SYNC reader.
//
// DRIVER-FREE on purpose (design D2): `approveOrderSync` runs inside a caller's
// transaction and cannot await `getSettings()`, so the commission module reads the
// settings blob synchronously from the adapter it was given. The async repo takes
// its defaults from here too, so the two readers can never disagree.
//
// Money is integer: đồng for VND, nano-USD for USD (1 USDT = 1 USD, no rate).
import { parseJson } from "../db/helpers/jsonCol.js";

/** 1 USD = 1e9 nano-USD. Repeated here to keep this module free of UI imports. */
export const NANO_PER_USD = 1_000_000_000;

export const AFFILIATE_SETTING_DEFAULTS = {
  affiliateEnabled: false,
  // 1000 bp = 10%.
  affiliateDefaultRateBp: 1000,
  // 0 = every order earns commission.
  affiliateDefaultMaxOrders: 1,
  affiliateHoldDays: 7,
  affiliateCookieDays: 30,
  affiliateMinWithdrawVnd: 100_000,
  // $5.
  affiliateMinWithdrawUsdNano: 5 * NANO_PER_USD,
  affiliateDefaultGiftCodeId: "",
};

/** `[min, max]` of every integer affiliate setting; `null` = no upper bound. */
export const AFFILIATE_SETTING_RANGES = {
  affiliateDefaultRateBp: [0, 10000],
  affiliateDefaultMaxOrders: [0, 1000],
  affiliateHoldDays: [0, 365],
  affiliateCookieDays: [1, 365],
  affiliateMinWithdrawVnd: [0, null],
  affiliateMinWithdrawUsdNano: [0, null],
};

/** The setting keys this capability owns. */
export const AFFILIATE_SETTING_KEYS = Object.keys(AFFILIATE_SETTING_DEFAULTS);

function isBlank(value) {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/**
 * A whole number as sent by a form or a script, or NaN. Strings must be plain
 * digits: `Number("100.000")` is 100, which once turned a minimum of one hundred
 * thousand đồng into 100đ. Booleans and other types are refused (`Number(true)` is 1).
 */
export function toWholeNumber(raw) {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  return NaN;
}

/**
 * Validate the affiliate keys of a settings patch and return them normalised, or
 * `{ error }` with the Vietnamese message the admin page shows. Keys absent from
 * the patch are left alone; nothing is written here.
 *
 * @returns {{ value: object, error?: undefined } | { error: string, value?: undefined }}
 */
export function validateAffiliateSettings(patch) {
  const body = patch || {};
  const value = {};

  for (const [key, [min, max]] of Object.entries(AFFILIATE_SETTING_RANGES)) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    const raw = body[key];
    // "" from an untouched number input must not silently become 0 for a key whose
    // minimum is above 0.
    if (isBlank(raw)) return { error: `${key} không được để trống` };
    const n = toWholeNumber(raw);
    if (!Number.isSafeInteger(n) || n < min || (max !== null && n > max)) {
      const range = max === null ? `≥ ${min}` : `${min}–${max}`;
      return { error: `${key} phải là số nguyên trong khoảng ${range}` };
    }
    value[key] = n;
  }

  if (Object.prototype.hasOwnProperty.call(body, "affiliateEnabled")) {
    if (typeof body.affiliateEnabled !== "boolean") {
      return { error: "affiliateEnabled phải là true hoặc false" };
    }
    value.affiliateEnabled = body.affiliateEnabled;
  }

  if (Object.prototype.hasOwnProperty.call(body, "affiliateDefaultGiftCodeId")) {
    const raw = body.affiliateDefaultGiftCodeId;
    value.affiliateDefaultGiftCodeId = typeof raw === "string" ? raw.trim() : "";
  }

  return { value };
}

/**
 * Validate one per-affiliate override (design D8). `null`/"" clears it, which
 * means "follow the program default". The bounds are the defaults' own bounds.
 *
 * @returns {{ value: number|null, error?: undefined } | { error: string, value?: undefined }}
 */
export function validateOverride(key, raw) {
  const range = key === "rateBp" ? AFFILIATE_SETTING_RANGES.affiliateDefaultRateBp
    : key === "maxOrders" ? AFFILIATE_SETTING_RANGES.affiliateDefaultMaxOrders
      : null;
  if (!range) return { error: `Không hỗ trợ trường ${key}` };
  if (isBlank(raw)) return { value: null };
  const n = toWholeNumber(raw);
  if (!Number.isSafeInteger(n) || n < range[0] || (range[1] !== null && n > range[1])) {
    const label = key === "rateBp" ? "Tỷ lệ hoa hồng" : "Số đơn";
    return { error: `${label} phải là số nguyên trong khoảng ${range[0]}–${range[1]}` };
  }
  return { value: n };
}

/**
 * Read the affiliate settings SYNCHRONOUSLY from the same `settings` row
 * `settingsRepo.getSettings()` reads, merging the same defaults. Never awaits:
 * safe inside `db.transaction`.
 *
 * @param {object} db adapter
 * @returns {typeof AFFILIATE_SETTING_DEFAULTS & { [key: string]: unknown }}
 */
export function readAffiliateSettingsSync(db) {
  if (!db) throw new Error("readAffiliateSettingsSync requires the db adapter");
  const row = db.get(`SELECT data FROM settings WHERE id = 1`);
  const raw = row ? parseJson(row.data, {}) || {} : {};
  const merged = { ...AFFILIATE_SETTING_DEFAULTS };
  for (const key of AFFILIATE_SETTING_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    merged[key] = value;
  }
  return merged;
}
