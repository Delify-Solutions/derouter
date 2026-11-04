// Email masking for the affiliate screens (design D8): the first two characters
// of the local part, then `***@domain`. An affiliate sees who its referrals are
// without learning an address it could contact or resell.

/**
 * `nguyen@example.com` → `ng***@example.com`.
 * A one-character local part keeps that character; an input that is not an
 * address at all is returned masked whole (`***`) rather than echoed back.
 */
export function maskEmail(email) {
  const raw = typeof email === "string" ? email.trim() : "";
  if (!raw) return "";
  const at = raw.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  if (!domain) return "***";
  return `${local.slice(0, 2)}***@${domain}`;
}

/**
 * Last four characters of an account number or address, for the Telegram
 * notification. Nothing else crosses that channel (design D5).
 */
export function maskTail(value, keep = 4) {
  const raw = typeof value === "string" ? value.trim() : String(value ?? "");
  if (!raw) return "";
  const n = Math.max(0, Math.floor(Number(keep) || 0));
  return n === 0 ? "***" : `***${raw.slice(-n)}`;
}
