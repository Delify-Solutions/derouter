// Plan spending limits: a short list of (window length, maximum) pairs.
//
// A limit means "inside any window of `hours` hours that this purchase has opened,
// spending may not exceed `maxNanoUsd`". The window length is in whole hours and
// the maximum is integer nano-USD, like every other money value in the app.
//
// Validation rules (spec plan-templates "Limit validation"), all of them rejected
// with a Vietnamese message naming the offending limit:
//   1. `hours` is an integer, 1 <= hours <= durationDays * 24;
//   2. `maxNanoUsd` is an integer > 0 and strictly less than the plan's credit;
//   3. no two limits share the same `hours`;
//   4. for hours a < b, max(a) <= max(b)  — a shorter window may not allow more
//      than a longer one, which would make the longer one meaningless;
//   5. at most 5 limits.
//
// This module is PURE (design D8): no driver, no repo, no I/O. It may import the
// money helpers only.
import { fmtUsdNano } from "../../shared/utils/money.js";

export const MAX_LIMITS = 5;

/** Preset window lengths offered by the admin form. */
export const WINDOW_PRESETS = [
  { hours: 5, label: "5 giờ" },
  { hours: 24, label: "1 ngày" },
  { hours: 168, label: "1 tuần" },
];

/**
 * Human label for a window length. `12` is "12 giờ", not "12 giờ" with a plural
 * form — Vietnamese has none, which is why there is no special case here.
 */
export function windowLabel(hours) {
  const n = Number(hours);
  if (n === 5) return "5 giờ";
  if (n === 24) return "1 ngày";
  if (n === 168) return "1 tuần";
  return `${Number.isFinite(n) ? Math.round(n) : 0} giờ`;
}

/**
 * Money for limit copy: `fmtUsdNano` with the trailing `.00` dropped, so a round
 * dollar amount reads "$20" (as the spec's examples do) while a fractional one
 * keeps its cents ("$19.50").
 */
function fmtLimitAmount(nanoUsd) {
  return fmtUsdNano(nanoUsd).replace(/\.00$/, "");
}

/** `Tối đa $20 mỗi 5 giờ` */
export function describeLimit(limit) {
  if (!limit) return "";
  return `Tối đa ${fmtLimitAmount(limit.maxNanoUsd)} mỗi ${windowLabel(limit.hours)}`;
}

/** Integer nano-USD from anything numeric. Never NaN, never a float. */
function nano(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Normalise a raw limits value into `[{ hours, maxNanoUsd }]`, sorted by hours.
 *
 * Accepts an already-parsed array or a JSON string. `null`/`undefined`/`[]` → `[]`
 * (no limits). A non-array value throws `TypeError`: silently treating garbage as
 * "no limits" would turn a corrupt row into unlimited spending.
 *
 * @param {string|Array|null|undefined} raw
 * @returns {Array<{hours:number, maxNanoUsd:number}>}
 */
export function normalizeLimits(raw) {
  if (raw == null) return [];
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new TypeError("limits phải là một mảng JSON");
    }
    if (value == null) return [];
  }
  if (!Array.isArray(value)) throw new TypeError("limits phải là một mảng");

  const out = value.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new TypeError("Mỗi hạn mức phải là một object { hours, maxNanoUsd }");
    }
    // `max` is accepted as an alias so an API caller can send the natural field
    // name; the stored/normalised form is always `maxNanoUsd`.
    const maxSource = entry.maxNanoUsd ?? entry.max;
    return { hours: nano(entry.hours), maxNanoUsd: nano(maxSource) };
  });

  return out.sort((a, b) => a.hours - b.hours);
}

/**
 * Validate a limits list against the plan it belongs to.
 *
 * @param {Array|string|null} raw
 * @param {{ creditNanoUsd?: number, durationDays?: number }} plan
 * @returns {string|null} Vietnamese error message, or null when valid
 */
export function validateLimits(raw, { creditNanoUsd = 0, durationDays = 0 } = {}) {
  // Parse the raw value first: normalizeLimits rounds for storage, which would hide
  // a fractional window length (2.5h → 3h) instead of rejecting it.
  let rawList;
  try {
    rawList = raw == null ? [] : typeof raw === "string" ? JSON.parse(raw) ?? [] : raw;
  } catch {
    return "limits phải là một mảng JSON";
  }
  if (!Array.isArray(rawList)) return "limits phải là một mảng";
  for (const entry of rawList) {
    const hours = Number(entry?.hours);
    if (!Number.isFinite(hours) || !Number.isInteger(hours)) {
      return `Hạn mức ${windowLabel(hours)}: số giờ phải là số nguyên từ 1 trở lên`;
    }
  }

  let limits;
  try {
    limits = normalizeLimits(rawList);
  } catch (error) {
    return error.message;
  }

  const credit = nano(creditNanoUsd);
  const days = nano(durationDays);
  const maxHours = days > 0 ? days * 24 : 0;

  if (limits.length > MAX_LIMITS) {
    return `Mỗi gói chỉ có tối đa ${MAX_LIMITS} hạn mức`;
  }

  const seen = new Set();
  for (const limit of limits) {
    const label = windowLabel(limit.hours);

    // 1. Window length is a whole number of hours inside the plan's duration.
    if (!Number.isInteger(limit.hours) || limit.hours < 1) {
      return `Hạn mức ${label}: số giờ phải là số nguyên từ 1 trở lên`;
    }
    if (maxHours > 0 && limit.hours > maxHours) {
      return `Hạn mức ${label} dài hơn thời hạn gói (${days} ngày)`;
    }

    // 2. The maximum is a positive amount below the plan's own credit: equal to or
    //    above it would be a ceiling the credit always hits first, i.e. no limit
    //    at all dressed up as one.
    if (!Number.isInteger(limit.maxNanoUsd) || limit.maxNanoUsd <= 0) {
      return `Hạn mức ${label}: mức tối đa phải lớn hơn $0`;
    }
    if (credit > 0 && limit.maxNanoUsd >= credit) {
      return `Hạn mức ${label}: mức tối đa phải nhỏ hơn credit của gói (${fmtLimitAmount(credit)})`;
    }

    // 3. One limit per window length.
    if (seen.has(limit.hours)) {
      return `Có hai hạn mức cùng dùng cửa sổ ${label}`;
    }
    seen.add(limit.hours);
  }

  // 4. Monotonic in the window length: limits is sorted by hours here, so a
  //    decreasing maximum means the shorter window allowed more.
  for (let i = 1; i < limits.length; i += 1) {
    const prev = limits[i - 1];
    const next = limits[i];
    if (next.maxNanoUsd < prev.maxNanoUsd) {
      return `Hạn mức ${windowLabel(prev.hours)} (${fmtLimitAmount(prev.maxNanoUsd)}) không được lớn hơn hạn mức ${windowLabel(next.hours)} (${fmtLimitAmount(next.maxNanoUsd)})`;
    }
  }

  return null;
}

/**
 * Stored form: sorted JSON, or `null` when there are no limits (so the column
 * reads as "no limits" rather than an empty array that every reader has to
 * interpret).
 */
export function serializeLimits(raw) {
  const limits = normalizeLimits(raw);
  if (limits.length === 0) return null;
  return JSON.stringify(limits);
}

/**
 * Parse a stored column. Bad JSON or a non-array yields `[]`: a corrupt snapshot
 * must not crash admission, and "no limits" is the safe reading (the plan still
 * stops at its credit).
 */
export function parseLimits(text) {
  if (text == null || text === "") return [];
  try {
    return normalizeLimits(text);
  } catch {
    return [];
  }
}

/**
 * `["Tối đa $20 mỗi 5 giờ", "Tối đa $80 mỗi 1 tuần"]` — for API payloads and cards.
 */
export function describeLimits(raw) {
  return normalizeLimits(raw).map(describeLimit);
}
