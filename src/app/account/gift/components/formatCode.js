// Display-only formatting for gift codes: the server stores them normalised, the
// UI shows them grouped in fours (K7QM-3XTP-9WFA-2BHC). Kept client-side so the
// page never imports the DB layer.
export function normalizeGiftCode(input) {
  return String(input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function formatGiftCode(input) {
  const key = normalizeGiftCode(input);
  if (!key) return "";
  const chunks = [];
  for (let i = 0; i < key.length; i += 4) chunks.push(key.slice(i, i + 4));
  return chunks.join("-");
}
