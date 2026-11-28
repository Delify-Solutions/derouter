// Vendor-cost rate shape (spec vendor-cost-pricing) — the same 5 token-rate fields as
// pricingMatch.js's PRICING_FIELDS, minus `image` (vendor cost has no per-image variant).
// Kept standalone (not imported from pricingMatch.js) so the two admin-only concepts
// (customer sell price vs. admin vendor cost) never share mutable state.

export const VENDOR_COST_RATE_FIELDS = [
  { key: "input", label: "Input ($/1M)" },
  { key: "cached", label: "Cache read ($/1M)" },
  { key: "cache_creation", label: "Cache write ($/1M)" },
  { key: "output", label: "Output ($/1M)" },
  { key: "reasoning", label: "Reasoning ($/1M)" },
];

const VALID_RATE_FIELDS = VENDOR_COST_RATE_FIELDS.map((f) => f.key);

export const EMPTY_RATE_DRAFT = Object.fromEntries(VALID_RATE_FIELDS.map((k) => [k, ""]));

/** Parse a form draft (string fields, possibly "") into a numeric rate object. Throws on invalid input. */
export function parseRateDraft(draft) {
  const parsed = {};
  for (const f of VALID_RATE_FIELDS) {
    const v = draft?.[f];
    parsed[f] = v === "" || v == null ? 0 : Number(v);
    if (Number.isNaN(parsed[f]) || parsed[f] < 0) {
      throw new Error(`${f} must be a non-negative number`);
    }
  }
  return parsed;
}

/** Convert a numeric rate object to a string draft for form inputs. */
export function rateToDraft(rate) {
  const draft = { ...EMPTY_RATE_DRAFT };
  for (const f of VALID_RATE_FIELDS) {
    draft[f] = rate?.[f] != null ? String(rate[f]) : "";
  }
  return draft;
}

/** Is a rate draft entirely empty (every field blank)? */
export function isRateDraftEmpty(draft) {
  return VALID_RATE_FIELDS.every((f) => draft?.[f] === "" || draft?.[f] == null);
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidTimeOfDay(s) {
  return typeof s === "string" && TIME_RE.test(s);
}

/**
 * Empty editor state for the vendor-cost form: on-peak (or flat) rate, the
 * peak-schedule toggle, and the off-peak rate + window (used only when enabled).
 */
export function emptyVendorCostDraft() {
  return {
    rate: { ...EMPTY_RATE_DRAFT },
    peakEnabled: false,
    offPeakRate: { ...EMPTY_RATE_DRAFT },
    start: "22:00",
    end: "06:00",
  };
}

/** Convert a stored vendor-cost record ({ rate, offPeak? }) to editor state, or empty if none. */
export function vendorCostRecordToDraft(record) {
  if (!record) return emptyVendorCostDraft();
  return {
    rate: rateToDraft(record.rate),
    peakEnabled: !!record.offPeak,
    offPeakRate: rateToDraft(record.offPeak?.rate),
    start: record.offPeak?.start || "22:00",
    end: record.offPeak?.end || "06:00",
  };
}

/**
 * Editor state -> the record the API expects ({ rate, offPeak? }), or `null` when the
 * admin left every on-peak field blank (meaning "no vendor cost configured"). Throws on
 * invalid numeric input.
 */
export function vendorCostDraftToRecord(draft) {
  if (!draft || isRateDraftEmpty(draft.rate)) return null;
  const rate = parseRateDraft(draft.rate);
  if (!draft.peakEnabled) return { rate };
  if (!isValidTimeOfDay(draft.start) || !isValidTimeOfDay(draft.end)) {
    throw new Error("Khung giờ off-peak phải có định dạng HH:MM");
  }
  const offPeakRate = parseRateDraft(draft.offPeakRate);
  return { rate, offPeak: { rate: offPeakRate, start: draft.start, end: draft.end } };
}
