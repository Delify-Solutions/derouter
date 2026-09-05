// Shared pricing constants + helpers used by the combos page (combo pricing auto-fill)
// and the pricing page (pool pricing table). Keeps the 5-field schema in one place.

import type { PricingFields } from '@/shared/types';

export const VALID_FIELDS = ["input", "output", "cached", "reasoning", "cache_creation"] as const;
export type ValidField = (typeof VALID_FIELDS)[number];

export const PRICING_FIELDS: ReadonlyArray<{ key: ValidField; label: string }> = [
  { key: "input", label: "Input ($/1M)" },
  { key: "cached", label: "Cache read ($/1M)" },
  { key: "cache_creation", label: "Cache write ($/1M)" },
  { key: "output", label: "Output ($/1M)" },
  { key: "reasoning", label: "Reasoning ($/1M)" },
];

export const EMPTY_PRICING: Record<ValidField, string> = {
  input: "",
  output: "",
  cached: "",
  reasoning: "",
  cache_creation: "",
};

type PricingDraft = Partial<Record<ValidField, string | number | null>>;

// Validate a pricing object's fields. Returns an error string or null.
export function validatePricingFields(pricing: unknown, label: string): string | null {
  if (typeof pricing !== "object" || pricing === null) {
    return `Invalid pricing for ${label}`;
  }
  for (const [key, value] of Object.entries(pricing as Record<string, unknown>)) {
    if (!VALID_FIELDS.includes(key as ValidField)) return `Invalid pricing field: ${key} for ${label}`;
    if (typeof value !== "number" || isNaN(value) || value < 0) {
      return `Invalid pricing value for ${key} in ${label}: must be non-negative number`;
    }
  }
  return null;
}

// Parse a form draft (string fields, possibly "") into a numeric pricing object.
// Empty strings → 0. Invalid → throws.
export function parsePricingDraft(draft: PricingDraft | null | undefined): Record<ValidField, number> {
  const parsed = {} as Record<ValidField, number>;
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
export function pricingToDraft(entry: PricingFields | null | undefined): Record<ValidField, string> {
  const draft = { ...EMPTY_PRICING };
  for (const f of VALID_FIELDS) {
    draft[f] = entry?.[f] != null ? String(entry[f]) : "";
  }
  return draft;
}

// Levenshtein distance (iterative, bounded). Used for fuzzy model-name matching.
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
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
function norm(s: string | null | undefined): string {
  return String(s || "").toLowerCase().replace(/[-_.]/g, "").replace(/\d{8}$/, "").replace(/^[^/]+\//, "");
}

// Find the closest pool pricing entry for a (provider, model) pair.
// `poolPricing` shape: { provider: { model: { input, output, ... } } } (from GET /api/pricing).
// 1. Exact (provider, model) match.
// 2. Same provider, closest model name by Levenshtein on the normalized name.
// 3. Any provider, closest model name.
// Returns the 5-field pricing object, or null if poolPricing is empty.
export function closestPoolModel(
  poolPricing: Record<string, Record<string, PricingFields>> | null,
  provider: string,
  model: string,
): PricingFields | null {
  if (!poolPricing || typeof poolPricing !== "object") return null;

  // 1. Exact match.
  if (provider && model && poolPricing[provider]?.[model]) {
    return poolPricing[provider][model];
  }

  const target = norm(model);
  let best: PricingFields | null = null;
  let bestScore = Infinity;

  const consider = (entry: PricingFields | undefined, label: string): void => {
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
