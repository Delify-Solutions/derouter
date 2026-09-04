/**
 * Model id matching used by both the API key enforcement layer
 * (src/lib/auth/keyEnforcement.js — isModelAllowed) and the /api/models
 * route (key-scoped filter).
 *
 * Allow-list entries are usually full catalog ids ("anthropic/claude-haiku-4-5-20251001")
 * captured by the AllowedModelsPicker, but admins may also type shorter forms
 * ("anthropic/claude-haiku-4-5" or just "claude-haiku-4-5"). Incoming LLM requests
 * carry whatever the SDK sent (bare "claude-haiku-4.5", a provider alias like
 * "bm/claude-haiku-4-5", or the full dated "anthropic/claude-haiku-4-5-20251001").
 *
 * Matching rules (symmetric — either side may be the longer/shorter form):
 *   1. Exact string equality.
 *   2. Same normalized id (provider-stripped, date suffix stripped) → match,
 *      so provider alias / bare id / dated id all collapse together.
 *   3. Suffix match at a "/" boundary (one side is a suffix of the other).
 */

// Strip a leading "provider/" prefix, returning { provider, id }.
function splitProvider(s) {
  if (!s || typeof s !== "string") return { provider: null, id: "" };
  const i = s.indexOf("/");
  if (i === -1) return { provider: null, id: s };
  return { provider: s.slice(0, i), id: s.slice(i + 1) };
}

// Strip a trailing date-like suffix ("-20251001", "-2025-10-01", "-latest") from a model id.
function stripDateSuffix(id) {
  if (!id) return id;
  // -20251001 or -2025-10-01 at the end
  const dated = id.replace(/-(?:\d{4}-?\d{2}-?\d{2}|latest)$/, "");
  return dated || id;
}

// Canonical comparison key: provider-stripped, date-suffix-stripped, lowercased.
export function modelIdKey(s) {
  const { id } = splitProvider(s);
  return stripDateSuffix(id).toLowerCase();
}

/**
 * Does `requested` match any entry in `allowList`?
 * @param {string} requested - the model id the client / catalog row carries
 * @param {string[]} allowList - allowed model ids (full or partial forms)
 * @returns {boolean}
 */
export function matchesAllowed(requested, allowList) {
  if (!Array.isArray(allowList) || allowList.length === 0) return true; // empty = unrestricted
  if (!requested) return false;
  const reqKey = modelIdKey(requested);
  const reqLow = String(requested).toLowerCase();
  for (const allow of allowList) {
    if (allow == null) continue;
    const aLow = String(allow).toLowerCase();
    if (aLow === reqLow) return true;
    if (modelIdKey(allow) === reqKey) return true;
    // suffix at "/" boundary: "claude-haiku-4-5" matches "anthropic/claude-haiku-4-5"
    // and vice-versa (but only when the bare-id keys already differ — handled by keys above
    // for the common case; this catches e.g. allow "claude-haiku-4-5" vs requested
    // "claude-haiku-4-5-thinking", which should NOT match, so require exact boundary).
    if (reqLow.endsWith("/" + aLow) || aLow.endsWith("/" + reqLow)) return true;
  }
  return false;
}

// Back-compat alias for /api/models route's existing modelMatches usage.
export function modelMatches(fullModel, allow) {
  return matchesAllowed(fullModel, [allow]);
}
