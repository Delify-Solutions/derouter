// Display-only formatting for gift codes: the server stores them normalised. A
// generated 16-character code is shown in fours (K7QM-3XTP-9WFA-2BHC); a code the
// admin chose (WELCOME2026) is shown as is. Mirrors giftRepo.formatGiftCode, kept
// client-side so the page never imports the DB layer.
export function normalizeGiftCode(input) {
  return String(input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function formatGiftCode(input) {
  const key = normalizeGiftCode(input);
  if (!key) return "";
  if (key.length !== 16) return key;
  const chunks = [];
  for (let i = 0; i < key.length; i += 4) chunks.push(key.slice(i, i + 4));
  return chunks.join("-");
}

/**
 * What the redeem field shows while the customer types: the display form of what
 * has been typed so far (same rule as formatGiftCode). Deterministic, so dashes
 * cannot linger after a code grows past 16 characters (WELCOMETOTHETET2026).
 */
export function formatTypedGiftCode(raw) {
  return formatGiftCode(raw);
}
