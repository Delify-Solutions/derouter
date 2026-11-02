// Multi-period terms: buying a plan for 1, 3, 6, 12… periods at once (spec plan-terms).
//
// A plan's period is its `durationDays` (30 days = "1 tháng"). Besides the single
// period that every plan sells, the admin may offer longer terms, each with its own
// discount: `[{ periods: 3, discountPercent: 5 }, { periods: 12, discountPercent: 15 }]`.
// Buying N periods grants N back-to-back purchases, each with the plan's own credit,
// duration and limits, so a 3-month term behaves exactly like three monthly
// purchases made on time — only the price differs.
//
// PURE (no imports, no I/O): the server prices orders with it and the purchase cards
// preview with it, so the number a customer sees is the number they are charged.

export const MAX_TERM_PERIODS = 36;
export const MAX_TERM_OPTIONS = 8;
export const MAX_TERM_DISCOUNT_PERCENT = 90;

const SINGLE = Object.freeze({ periods: 1, discountPercent: 0 });

function toInt(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
}

/**
 * The stored extra terms, cleaned: periods 2..MAX, discount 0..MAX, one entry per
 * period count, sorted by periods. Anything unreadable is dropped (a hand-edited
 * row must not break the catalogue). Accepts the JSON column or an array.
 */
export function parseTermOptions(value) {
  let raw = value;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(raw)) return [];
  const byPeriods = new Map();
  for (const entry of raw) {
    const periods = toInt(entry?.periods);
    const discountPercent = entry?.discountPercent == null || entry.discountPercent === "" ? 0 : toInt(entry.discountPercent);
    if (!(periods >= 2 && periods <= MAX_TERM_PERIODS)) continue;
    if (!(discountPercent >= 0 && discountPercent <= MAX_TERM_DISCOUNT_PERCENT)) continue;
    byPeriods.set(periods, { periods, discountPercent });
  }
  return [...byPeriods.values()].sort((a, b) => a.periods - b.periods);
}

/** JSON for the plans.termOptions column, or null when only one period is sold. */
export function serializeTermOptions(value) {
  const terms = parseTermOptions(value);
  return terms.length ? JSON.stringify(terms) : null;
}

/**
 * Vietnamese error for an admin-submitted term list, or null. Strict where
 * `parseTermOptions` is lenient: the admin is told what is wrong instead of an
 * entry silently disappearing.
 */
export function validateTermOptions(value, { allowCustomAmount = false } = {}) {
  if (value == null || value === "") return null;
  const raw = typeof value === "string" ? (() => { try { return JSON.parse(value); } catch { return undefined; } })() : value;
  if (!Array.isArray(raw)) return "Kỳ hạn phải là một danh sách";
  if (raw.length === 0) return null;
  if (allowCustomAmount) return "Gói nạp số tiền tùy ý không bán theo kỳ hạn dài";
  if (raw.length > MAX_TERM_OPTIONS) return `Tối đa ${MAX_TERM_OPTIONS} kỳ hạn`;
  const seen = new Set();
  for (const entry of raw) {
    const periods = toInt(entry?.periods);
    if (!(periods >= 2 && periods <= MAX_TERM_PERIODS)) {
      return `Số kỳ phải là số nguyên từ 2 đến ${MAX_TERM_PERIODS}`;
    }
    if (seen.has(periods)) return `Kỳ ${periods} bị lặp`;
    seen.add(periods);
    const discount = entry?.discountPercent == null || entry.discountPercent === "" ? 0 : toInt(entry.discountPercent);
    if (!(discount >= 0 && discount <= MAX_TERM_DISCOUNT_PERCENT)) {
      return `% giảm phải là số nguyên từ 0 đến ${MAX_TERM_DISCOUNT_PERCENT}`;
    }
  }
  return null;
}

/**
 * Every term a customer may buy for this plan, single period first. A custom-amount
 * top-up plan is priced by the typed amount, so it only ever sells one period.
 */
export function planTerms(plan) {
  if (!plan) return [SINGLE];
  if (plan.allowCustomAmount === true) return [SINGLE];
  return [SINGLE, ...parseTermOptions(plan.termOptions)];
}

/** The offered term with this many periods, or null when the plan does not sell it. */
export function findTerm(plan, periods = 1) {
  const n = periods == null || periods === "" ? 1 : toInt(periods);
  return planTerms(plan).find((term) => term.periods === n) ?? null;
}

/** price × periods × (100 − discount) / 100, rounded half up, in integers. */
function discounted(price, periods, discountPercent) {
  const base = BigInt(Math.max(0, Math.round(Number(price) || 0)));
  const total = base * BigInt(periods) * BigInt(100 - discountPercent);
  return Number((total + 50n) / 100n);
}

/**
 * What a term costs, in both currencies the plan is sold in.
 *
 * @returns {{ periods:number, discountPercent:number, priceNanoUsd:number,
 *             priceVnd:number|null, fullPriceNanoUsd:number, fullPriceVnd:number|null }}
 */
export function termPrice(plan, term) {
  const periods = term?.periods ?? 1;
  const discountPercent = term?.discountPercent ?? 0;
  const priceVnd = Number(plan?.priceVnd) > 0 ? Number(plan.priceVnd) : null;
  return {
    periods,
    discountPercent,
    priceNanoUsd: discounted(plan?.priceNanoUsd, periods, discountPercent),
    priceVnd: priceVnd == null ? null : discounted(priceVnd, periods, discountPercent),
    fullPriceNanoUsd: discounted(plan?.priceNanoUsd, periods, 0),
    fullPriceVnd: priceVnd == null ? null : discounted(priceVnd, periods, 0),
  };
}

/**
 * "3 tháng" for a 30-day plan, "90 ngày" otherwise. One period of a 28–31 day plan
 * reads as a month, which is how the owner sells it.
 */
export function termLabel(durationDays, periods = 1) {
  const days = Math.max(1, Math.round(Number(durationDays) || 0));
  const n = Math.max(1, Math.round(Number(periods) || 1));
  if (days >= 28 && days <= 31) return `${n} tháng`;
  if (days % 30 === 0) return `${(days / 30) * n} tháng`;
  return `${days * n} ngày`;
}
