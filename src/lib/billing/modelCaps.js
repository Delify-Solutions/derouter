// Spending caps on a group of models inside a plan's credit pool (spec plan-queue-billing
// "A full model cap refuses that model only").
//
// A cap is { id, label, models, maxNanoUsd, hours }:
//   models      combo names, matched like group/plan allow-lists
//   maxNanoUsd  the most the models of this cap may take from the purchase's pool
//   hours       null  → the whole life of the purchase (only null/undefined; 0 or "" is refused) ("$15 for images, in total")
//               N     → each window of N hours, opened at the first charge like a plan limit
//
// The pool stays shared: spend on a capped model still reduces the purchase's credit and
// counts in its window limits. A cap only ADDS a restriction on how much of the pool a
// model group may take.
//
// PURE (no driver, no I/O): admission, charging, the customer page, the admin form and the
// tests read the same rules from here. Relative imports only (plain `node --test`), and
// nothing Node-only: the admin form imports this file too.
import { matchesAllowed } from "../auth/modelMatching.js";
import { fmtLimitAmount, windowLabel } from "./limits.js";
import { isImagePlan } from "./planKind.js";

export const MAX_MODEL_CAPS = 5;
const MAX_LABEL = 40;
const HOUR_MS = 60 * 60 * 1000;

function nano(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : 0;
}

// Web Crypto exists in Node 20+ and in the browser, so the admin form (which imports this
// module to validate a draft) needs no Node-only import.
function newCapId() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(4));
  return `cap_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Normalise a raw value into `[{ id, label, models, maxNanoUsd, hours }]`.
 *
 * Accepts an array or a JSON string; null/undefined/[] → []. A non-array throws
 * TypeError: reading garbage as "no caps" would silently lift a restriction.
 * A missing id is generated (`makeId` is injectable for tests).
 */
export function normalizeModelCaps(raw, { makeId = newCapId } = {}) {
  if (raw == null) return [];
  let value = raw;
  if (typeof value === "string") {
    if (!value.trim()) return [];
    try {
      value = JSON.parse(value);
    } catch {
      throw new TypeError("modelCaps phải là một mảng JSON");
    }
    if (value == null) return [];
  }
  if (!Array.isArray(value)) throw new TypeError("modelCaps phải là một mảng");

  return value.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new TypeError("Mỗi giới hạn model phải là một object");
    }
    const models = Array.isArray(entry.models)
      ? [...new Set(entry.models.filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim()))]
      : [];
    // Only null/undefined mean "the whole life of the purchase". 0, "" and 1.5 are NOT coerced
    // into something else: they stay as given and validation refuses them, so a mistyped
    // window can never silently turn into a whole-term cap.
    const hoursRaw = entry.hours;
    const hours = hoursRaw == null ? null : Number(hoursRaw);
    return {
      id: typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : makeId(),
      label: typeof entry.label === "string" ? entry.label.trim() : "",
      models,
      maxNanoUsd: nano(entry.maxNanoUsd ?? entry.max),
      hours,
    };
  });
}

/** Tolerant read for a stored value: a corrupt row reads as "no caps". */
export function parseModelCaps(text) {
  try {
    return normalizeModelCaps(text, { makeId: () => "" }).filter((cap) => cap.id && cap.models.length > 0 && cap.maxNanoUsd > 0);
  } catch {
    return [];
  }
}

/** Stored form: JSON text, or null for none. */
export function serializeModelCaps(raw) {
  const caps = normalizeModelCaps(raw);
  return caps.length === 0 ? null : JSON.stringify(caps);
}

/**
 * Validate a plan's caps. Returns a Vietnamese message or null.
 *
 * Rules (design D7): at most 5; ids unique; label 1–40 chars; models non-empty; max a
 * positive integer, below the plan's credit for a finite plan (a cap that is not below it
 * could never bind); hours null or an integer from 1 to the duration in hours; refused on
 * an image-count plan (its unit is images and an image purchase cannot pay dollars).
 * Whether the models exist is checked by the caller, which has the database.
 */
export function validateModelCaps(raw, { kind = "llm", creditNanoUsd = 0, unlimited = false, durationDays = 0 } = {}) {
  let caps;
  try {
    caps = normalizeModelCaps(raw);
  } catch (error) {
    return error.message;
  }
  if (caps.length === 0) return null;
  if (isImagePlan(kind)) return "Gói ảnh không có giới hạn theo model — giới hạn tính bằng số ảnh của gói.";
  if (caps.length > MAX_MODEL_CAPS) return `Tối đa ${MAX_MODEL_CAPS} giới hạn model mỗi gói.`;

  const ids = new Set();
  for (const cap of caps) {
    const name = cap.label || cap.id;
    if (ids.has(cap.id)) return `Giới hạn model "${name}": trùng mã.`;
    ids.add(cap.id);
    if (!cap.label) return "Mỗi giới hạn model cần một tên.";
    if (cap.label.length > MAX_LABEL) return `Tên giới hạn model tối đa ${MAX_LABEL} ký tự.`;
    if (cap.models.length === 0) return `Giới hạn "${cap.label}": chọn ít nhất một model.`;
    if (!Number.isInteger(cap.maxNanoUsd) || cap.maxNanoUsd <= 0) {
      return `Giới hạn "${cap.label}": mức tối đa phải là số tiền lớn hơn 0.`;
    }
    if (!unlimited && Number(creditNanoUsd) > 0 && cap.maxNanoUsd >= Number(creditNanoUsd)) {
      return `Giới hạn "${cap.label}": phải nhỏ hơn credit của gói (nếu không sẽ không bao giờ chạm tới).`;
    }
    if (cap.hours != null) {
      const maxHours = Number(durationDays) > 0 ? Number(durationDays) * 24 : Infinity;
      if (!Number.isInteger(cap.hours) || cap.hours < 1 || cap.hours > maxHours) {
        return `Giới hạn "${cap.label}": chu kỳ phải từ 1 giờ đến thời hạn của gói.`;
      }
    }
  }
  return null;
}

/**
 * The caps that apply to a request for `model`. A request with no known model matches none.
 * A model listed in several caps is subject to all of them.
 */
export function capsForModel(caps, model) {
  if (!model || !Array.isArray(caps) || caps.length === 0) return [];
  return caps.filter((cap) => matchesAllowed(model, cap.models));
}

/**
 * One cap's state at an instant, from the purchase's stored spend row.
 *
 * @param {object} cap
 * @param {{ startedAt: string, spentNanoUsd: number }|null} spend
 * @param {number} nowMs
 */
export function evaluateCap(cap, spend, nowMs) {
  const max = nano(cap.maxNanoUsd);
  let open = false;
  let closedAtMs = null;
  if (spend?.startedAt) {
    if (cap.hours == null) {
      open = true;
    } else {
      closedAtMs = new Date(spend.startedAt).getTime() + cap.hours * HOUR_MS;
      open = Number.isFinite(closedAtMs) && nowMs < closedAtMs;
    }
  }
  const spent = open ? nano(spend.spentNanoUsd) : 0;
  return {
    id: cap.id,
    label: cap.label,
    models: cap.models,
    hours: cap.hours,
    maxNanoUsd: max,
    spentNanoUsd: spent,
    roomNanoUsd: Math.max(0, max - spent),
    startedAt: open ? spend.startedAt : null,
    // A whole-term cap never reopens; a windowed one reopens when its window closes.
    resetAt: open && cap.hours != null ? new Date(closedAtMs).toISOString() : null,
    open,
    full: spent >= max,
  };
}

/** `Ảnh: tối đa $15 cho cả thời hạn gói` / `... mỗi 5 giờ`. */
export function describeModelCap(cap) {
  if (!cap) return "";
  const span = cap.hours == null ? "cho cả thời hạn gói" : `mỗi ${windowLabel(cap.hours)}`;
  return `${cap.label}: tối đa ${fmtLimitAmount(cap.maxNanoUsd)} ${span}`;
}
