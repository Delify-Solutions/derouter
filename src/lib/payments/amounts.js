// Decimal-string money parsing for payment providers (design D2).
//
// Providers send amounts as decimal STRINGS ("23.72469206", "18067000.00") and
// floats are the one thing this codebase never does to money. `parseDecimalToNano`
// converts an exact decimal string to an integer scaled by 1e9 by moving the
// decimal point in the string — no `Number()`, no `parseFloat`, so
// "0.00000001" is exactly 10 and not 9.999999999999999.
//
// Relative imports only: `node --test` loads this module directly.

const NANO_DIGITS = 9;
const DECIMAL_RE = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/;

/**
 * Exact decimal string → integer × 1e9.
 *
 * Rejects exponents ("1e3"), fractions shorter than 1 nano ("0.0000000001"),
 * signs (providers report direction separately) and anything not written as a
 * plain decimal. Returns null when the input cannot be represented exactly, so a
 * caller can decide between "skip" and "review".
 *
 * @param {string|number} value
 * @returns {number|null}
 */
export function parseDecimalToNano(value) {
  if (typeof value === "number") {
    // A JS number has already lost precision by the time we see it; only accept
    // it when it round-trips through its shortest decimal form exactly.
    if (!Number.isFinite(value) || value < 0) return null;
    value = String(value);
  }
  if (typeof value !== "string") return null;

  const text = value.trim();
  if (!text) return null;

  const match = DECIMAL_RE.exec(text);
  if (!match) return null;

  const fraction = match[1] ?? "";
  // More than 9 decimals cannot be represented in nano-units. Rejecting is the
  // safe answer: rounding a received amount could turn an underpayment into an
  // exact match.
  if (fraction.length > NANO_DIGITS) {
    // Trailing zeros carry no value ("0.0000000100" is exactly 10 nano).
    const trimmed = fraction.replace(/0+$/, "");
    if (trimmed.length > NANO_DIGITS) return null;
  }

  const [whole, frac = ""] = text.split(".");
  const padded = frac.padEnd(NANO_DIGITS, "0").slice(0, NANO_DIGITS);
  const nano = Number(whole) * 1e9 + Number(padded || "0");
  if (!Number.isSafeInteger(nano)) return null;
  return nano;
}

/**
 * Integer đồng → "250.000đ" (Vietnamese thousands separator is a dot).
 *
 * @param {number} value
 * @returns {string}
 */
export function formatVnd(value) {
  const n = Math.round(Number(value) || 0);
  const sign = n < 0 ? "-" : "";
  const digits = String(Math.abs(n));
  let out = "";
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ".";
    out += digits[i];
  }
  return `${sign}${out}đ`;
}

/**
 * Integer nano-USDT → a plain decimal string ("10.5"), trailing zeros dropped.
 *
 * Used for both display and the order page's copy field, so it must never round:
 * the customer has to send exactly the amount the order was priced at.
 *
 * @param {number} value
 * @returns {string}
 */
export function formatUsdt(value) {
  const n = Math.round(Number(value) || 0);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const whole = Math.floor(abs / 1e9);
  const frac = String(abs % 1e9).padStart(NANO_DIGITS, "0").replace(/0+$/, "");
  return `${sign}${whole}${frac ? `.${frac}` : ""}`;
}
