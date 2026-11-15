// Shared pricing constants + helpers used by the combos page (combo pricing auto-fill)
// and the pricing page (pool pricing table). Keeps the pricing schema in one place (token rates per 1M, plus a per-image price).

export const VALID_FIELDS = ["input", "output", "cached", "reasoning", "cache_creation", "image"];

export const PRICING_FIELDS = [
  { key: "input", label: "Input ($/1M)" },
  { key: "cached", label: "Cache read ($/1M)" },
  { key: "cache_creation", label: "Cache write ($/1M)" },
  { key: "output", label: "Output ($/1M)" },
  { key: "reasoning", label: "Reasoning ($/1M)" },
  { key: "image", label: "Image ($/image)" },
];

export const EMPTY_PRICING = {
  input: "",
  output: "",
  cached: "",
  reasoning: "",
  cache_creation: "",
  image: "",
};

// Validate a pricing object's fields. Returns an error string or null.
export function validatePricingFields(pricing, label) {
  if (typeof pricing !== "object" || pricing === null) {
    return `Invalid pricing for ${label}`;
  }
  for (const [key, value] of Object.entries(pricing)) {
    if (!VALID_FIELDS.includes(key)) return `Invalid pricing field: ${key} for ${label}`;
    if (typeof value !== "number" || isNaN(value) || value < 0) {
      return `Invalid pricing value for ${key} in ${label}: must be non-negative number`;
    }
  }
  return null;
}

// Parse a form draft (string fields, possibly "") into a numeric pricing object.
// Empty strings → 0. Invalid → throws.
export function parsePricingDraft(draft) {
  const parsed = {};
  for (const f of VALID_FIELDS) {
    const v = draft?.[f];
    parsed[f] = v === "" || v == null ? 0 : Number(v);
    if (isNaN(parsed[f]) || parsed[f] < 0) {
      throw new Error(`${f} must be a non-negative number`);
    }
  }
  return parsed;
}

// Convert a numeric pricing entry to a string draft for form inputs.
export function pricingToDraft(entry) {
  const draft = { ...EMPTY_PRICING };
  for (const f of VALID_FIELDS) {
    draft[f] = entry?.[f] != null ? String(entry[f]) : "";
  }
  return draft;
}

// Levenshtein distance (iterative, bounded). Used for fuzzy model-name matching.
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

// Normalize a model id for matching: lowercase, strip common version/date noise.
function norm(s) {
  return String(s || "").toLowerCase().replace(/[-_.]/g, "").replace(/\d{8}$/, "").replace(/^[^/]+\//, "");
}

// Find the closest pool pricing entry for a (provider, model) pair.
// `poolPricing` shape: { provider: { model: { input, output, ... } } } (from GET /api/pricing).
// 1. Exact (provider, model) match.
// 2. Same provider, closest model name by Levenshtein on the normalized name.
// 3. Any provider, closest model name.
// Returns the 5-field pricing object, or null if poolPricing is empty.
export function closestPoolModel(poolPricing, provider, model) {
  if (!poolPricing || typeof poolPricing !== "object") return null;

  // 1. Exact match.
  if (provider && model && poolPricing[provider]?.[model]) {
    return poolPricing[provider][model];
  }

  const target = norm(model);
  let best = null;
  let bestScore = Infinity;

  const consider = (entry, label) => {
    if (!entry) return;
    const d = levenshtein(target, norm(label));
    // Strong preference for substring containment.
    const sub = target && norm(label).includes(target) ? -100 : 0;
    const score = d + sub;
    if (score < bestScore) {
      bestScore = score;
      best = entry;
    }
  };

  // 2. Same provider models.
  if (provider && poolPricing[provider]) {
    for (const m of Object.keys(poolPricing[provider])) {
      consider(poolPricing[provider][m], m);
    }
  }

  // 3. All providers.
  for (const p of Object.keys(poolPricing)) {
    if (p === provider) continue;
    for (const m of Object.keys(poolPricing[p] || {})) {
      consider(poolPricing[p][m], m);
    }
  }

  return best;
}

// ── Quick price multipliers (spec combo-pricing-admin) ───────────────────────

/** Factors offered on the combo price form. 1 restores the base. */
export const PRICE_FACTORS = [0.5, 1, 2, 3];

const MICRO = 1_000_000n;

// "3.25" / 3.25 -> 3250000n. Anything that is not a finite non-negative number -> null.
function toMicro(value) {
  if (value === "" || value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return BigInt(n.toFixed(6).replace(".", ""));
}

function fromMicro(micro) {
  const whole = micro / MICRO;
  const frac = String(micro % MICRO).padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

/**
 * One price field times `factor`, in integer micro-units so 0.1 x 3 is exactly 0.3.
 * An empty or invalid value stays as it is. Rounded half up to 6 decimal places.
 */
export function scalePrice(value, factor) {
  const base = toMicro(value);
  const mult = toMicro(factor);
  if (base === null || mult === null) return value;
  return fromMicro((base * mult + MICRO / 2n) / MICRO);
}

/** A price draft (string fields) with every field multiplied by `factor`. */
export function scalePricingDraft(base, factor) {
  const out = { ...EMPTY_PRICING };
  for (const f of VALID_FIELDS) out[f] = scalePrice(base?.[f] ?? "", factor);
  return out;
}

/**
 * The base a multiplier button scales (spec combo-pricing-admin): the base captured at an earlier
 * press, else the pool price while the form still shows that auto-filled suggestion, else the
 * values in the form. An image combo, a combo with a saved price and a price the admin typed
 * (`touched`) are never re-based on a pool price, so a saved price cannot be overwritten.
 */
export function pickPriceBase({ captured = null, pool = null, current, isImage = false, touched = false }) {
  if (captured) return captured;
  if (!isImage && !touched && pool) return pool;
  return current;
}
