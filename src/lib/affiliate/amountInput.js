// Typed money → integer, for the affiliate forms (customer conversion/voucher, admin
// settings, admin wallet adjustment).
//
// Customers and admins type money the way they read it on screen: "100.000" for
// one hundred thousand đồng, "12.50" for twelve and a half dollars. Stripping
// every non-digit (what the forms did before) turned "100.000" into 100000 by
// luck but "12.50" USD into 1250 nano-USD, and "150000.5" đồng into 1,500,005.
// These parsers accept only unambiguous shapes and return null for anything
// else, so a form can say "invalid" instead of sending a wrong amount.
//
// Pure and dependency-free: imported by client components and by tests.

const NANO_DIGITS = 9;

/**
 * Đồng as typed → integer đồng, or null.
 * Accepts "100000", "100.000", "100,000" and "100 000" (thousands groups of
 * exactly three). Rejects decimals ("150000.5"), signs and anything else.
 */
export function parseVndInput(text) {
  const raw = String(text ?? "").trim().replace(/\s+/g, "");
  if (!raw) return null;
  let digits = null;
  if (/^\d+$/.test(raw)) digits = raw;
  else if (/^\d{1,3}(\.\d{3})+$/.test(raw)) digits = raw.replace(/\./g, "");
  else if (/^\d{1,3}(,\d{3})+$/.test(raw)) digits = raw.replace(/,/g, "");
  if (digits === null) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * USD as typed → integer nano-USD, or null. Exact: the decimal point is moved in
 * the string, never through a float, so "12.35" is 12_350_000_000 exactly.
 * Accepts an optional leading "$", a dot or a single comma as the decimal mark,
 * and up to 9 decimals.
 */
export function parseUsdInput(text) {
  let raw = String(text ?? "").trim().replace(/\s+/g, "").replace(/^\$/, "");
  if (!raw) return null;
  if (!raw.includes(".") && (raw.match(/,/g) || []).length === 1) raw = raw.replace(",", ".");
  const match = /^(\d+)(?:\.(\d{1,9}))?$/.exec(raw);
  if (!match) return null;
  const whole = Number(match[1]);
  const frac = Number((match[2] ?? "").padEnd(NANO_DIGITS, "0"));
  const nano = whole * 1e9 + frac;
  return Number.isSafeInteger(nano) ? nano : null;
}

/**
 * Signed variant for admin adjustments: a leading "-" (or "+") is allowed and the
 * rest goes through the currency's own parser. Returns null for 0 too, since an
 * adjustment of nothing is a mistake.
 */
export function parseSignedAmountInput(currency, text) {
  const raw = String(text ?? "").trim();
  const negative = raw.startsWith("-");
  const body = raw.replace(/^[+-]/, "");
  const value = currency === "VND" ? parseVndInput(body) : parseUsdInput(body);
  if (value === null || value === 0) return null;
  return negative ? -value : value;
}

/** Non-negative whole number as typed (days, order counts) → integer, or null. */
export function parseCountInput(text) {
  const raw = String(text ?? "").trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}
