// Referral codes (design D6, spec "One referral code per account").
//
// Six characters from an unambiguous alphabet, drawn from a cryptographic RNG.
// Codes are stored uppercase and matched case-insensitively.
//
// DRIVER-FREE: relative imports only.
import { randomInt } from "node:crypto";

/** No 0/O, no 1/I/L — the same rule gift codes follow, for the same reason. */
export const REFERRAL_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export const REFERRAL_CODE_LENGTH = 6;
/** Fallback length when six characters keep colliding (design D6). */
export const REFERRAL_CODE_LENGTH_FALLBACK = 8;

/** Uppercase and strip anything that is not a letter or digit. */
export function normalizeReferralCode(input) {
  return String(input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * One random code. `length` defaults to 6; `ensureAffiliateSync` retries the
 * INSERT and falls back to 8 characters.
 */
export function generateReferralCode(length = REFERRAL_CODE_LENGTH) {
  const n = Number.isInteger(length) && length > 0 ? length : REFERRAL_CODE_LENGTH;
  let out = "";
  for (let i = 0; i < n; i += 1) {
    out += REFERRAL_CODE_ALPHABET[randomInt(0, REFERRAL_CODE_ALPHABET.length)];
  }
  return out;
}
