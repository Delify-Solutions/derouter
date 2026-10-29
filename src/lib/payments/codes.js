// Order payment codes (design D2, spec payment-checkout "Payment code").
//
// A code is `<prefix><8 characters>` written into the transfer content. Two
// constraints shape the alphabet:
//   * letters and digits only — banks strip punctuation and accents from memos;
//   * no I, L, O or 0 and no 1 — the characters a human mistypes when copying a
//     code out of a banking app.
//
// Relative imports only: `node --test` loads this module directly.
import { randomInt as cryptoRandomInt } from "node:crypto";

export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 8;

const PREFIX_RE = /^[A-Z]{2,6}$/;

/** True when `prefix` may be used in a code (2–6 uppercase letters). */
export function isValidPrefix(prefix) {
  return typeof prefix === "string" && PREFIX_RE.test(prefix);
}

/**
 * A random code with `prefix` prepended.
 *
 * `randomInt` is injectable so a test can drive a deterministic sequence; it
 * defaults to the CSPRNG. Collision handling is the caller's job (the UNIQUE
 * index on orders.paymentCode is the real guarantee).
 *
 * @param {string} prefix
 * @param {(maxExclusive: number) => number} [randomInt]
 * @returns {string}
 */
export function generatePaymentCode(prefix, randomInt = cryptoRandomInt) {
  const base = String(prefix || "").toUpperCase();
  if (!isValidPrefix(base)) throw new Error("Mã thanh toán cần tiền tố 2–6 chữ cái in hoa");
  let out = base;
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Every distinct code-shaped token in `content`, in the order the matching rules
 * try them (design D2 step 3 / spec "Payment code extraction"):
 *
 *   1. the text as received, upper-cased — the common case, the customer typed
 *      the code and the bank wrapped it in its own prefix;
 *   2. the text with every non-alphanumeric character removed — covers customers
 *      who inserted spaces ("dr8k 3q7m zp") or had the memo line-wrapped.
 *
 * Both passes use one regex anchored on the prefix, so a memo without the prefix
 * can never produce a candidate.
 *
 * @param {string} content
 * @param {string} prefix
 * @returns {string[]} ordered, de-duplicated
 */
export function extractCandidateCodes(content, prefix) {
  const base = String(prefix || "").toUpperCase();
  if (!isValidPrefix(base)) return [];
  if (typeof content !== "string" || content === "") return [];

  const pattern = new RegExp(`${base}[${CODE_ALPHABET}]{${CODE_LENGTH}}`, "g");
  const out = [];
  const seen = new Set();

  const collect = (text) => {
    const matches = text.match(pattern);
    if (!matches) return;
    for (const match of matches) {
      if (seen.has(match)) continue;
      seen.add(match);
      out.push(match);
    }
  };

  collect(content.toUpperCase());
  // `\p{L}`/`\p{N}` rather than [a-z0-9]: a Vietnamese memo may contain accented
  // letters, and stripping only ASCII would leave "Đ" glued to the code.
  collect(content.normalize("NFC").toUpperCase().replace(/[^\p{L}\p{N}]/gu, ""));

  return out;
}
