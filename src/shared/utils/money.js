// Single money representation for the whole app: integer nanoUSD (1 USD = 1e9 nano).
// NEVER do float arithmetic on money — convert at the edges (DB stores integers,
// UI formats strings). Floats are only produced for legacy readers that still
// expect a `cost` number.
//
// Pricing rates (in `pricing` objects) are USD per 1M tokens, matching
// open-sse/providers/pricing.js.

export const NANO = 1_000_000_000; // 1 USD = 1e9 nanoUSD

// USD per 1M tokens -> nanoUSD per token.
const NANO_PER_RATE_UNIT = NANO / 1_000_000; // == 1000

/** Convert a USD amount (float, e.g. legacy `cost` column) to integer nanoUSD. */
export function usdToNano(usd) {
  if (usd === null || usd === undefined) return 0;
  const n = Number(usd);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * NANO);
}

/** Convert integer nanoUSD to a USD float. Display/legacy-interop only. */
export function nanoToUsd(nano) {
  const n = Number(nano);
  if (!Number.isFinite(n)) return 0;
  return n / NANO;
}

/**
 * Format integer nanoUSD for display with adaptive precision:
 *   >= $1     -> 2 decimals
 *   >= $0.01  -> 4 decimals
 *   otherwise -> 6 decimals
 * null/undefined/non-finite -> "$0".
 */
export function fmtUsdNano(nano) {
  const n = Number(nano);
  if (!Number.isFinite(n) || n === 0) return "$0";
  const usd = n / NANO;
  const abs = Math.abs(usd);
  const digits = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return `${usd < 0 ? "-" : ""}$${abs.toFixed(digits)}`;
}

/** What a credit figure reads as on a plan that has no credit ceiling. */
export const UNLIMITED_CREDIT_LABEL = "Không giới hạn";

/**
 * Credit for display: the label above for an unlimited plan, otherwise the
 * adaptive dollar format. Every screen that shows a plan's credit goes through
 * here so an unlimited plan can never render as "$0".
 */
export function fmtCreditNano(nano, unlimited = false) {
  return unlimited ? UNLIMITED_CREDIT_LABEL : fmtUsdNano(nano);
}

/** Format a legacy USD float through the same adaptive rules as fmtUsdNano. */
export function fmtUsd(usd) {
  return fmtUsdNano(usdToNano(usd));
}

/** Integer sum of a collection of nanoUSD values (null-safe, never overflows to float). */
export function sumNano(iterable) {
  if (!iterable) return 0;
  let total = 0;
  for (const v of iterable) {
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    total += Math.round(n);
  }
  return total;
}

function rate(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Compute the cost of one request as integer nanoUSD.
 *
 * Mirrors open-sse/providers/pricing.js calculateCostFromTokens (the single
 * source of truth for the cache-inclusive convention): `prompt_tokens` already
 * includes cached and cache-creation tokens, so subtract both before charging
 * the full input rate. Rounding happens ONCE, at the end.
 *
 * @param {object} tokens - usage payload (prompt_tokens / completion_tokens / cached_tokens / ...)
 * @param {object} pricing - USD per 1M tokens: { input, output, cached, reasoning, cache_creation }
 * @returns {number} integer nanoUSD
 */
/**
 * Cost of `count` generated images at `pricing.image` USD per image. Image models
 * are priced per image, not per token (the upstream reports no token usage), so a
 * missing or non-positive price is 0 and the caller decides whether that is allowed.
 */
export function costFromImagesNano(count, pricing) {
  const images = Math.floor(Number(count));
  const price = Number(pricing?.image);
  if (!Number.isFinite(images) || images <= 0 || !Number.isFinite(price) || price <= 0) return 0;
  return usdToNano(price) * images;
}

export function costFromTokensNano(tokens, pricing) {
  if (!tokens || !pricing) return 0;

  const inputTokens = tokens.prompt_tokens || tokens.input_tokens || 0;
  const cachedTokens = tokens.cached_tokens || tokens.cache_read_input_tokens || 0;
  const cacheCreationTokens = tokens.cache_creation_input_tokens || 0;
  // prompt_tokens is cache-inclusive → subtract both subsets.
  const nonCachedInput = Math.max(0, inputTokens - cachedTokens - cacheCreationTokens);

  const outputTokens = tokens.completion_tokens || tokens.output_tokens || 0;
  const reasoningTokens = tokens.reasoning_tokens || 0;

  let nano = 0;
  nano += nonCachedInput * rate(pricing.input) * NANO_PER_RATE_UNIT;
  if (cachedTokens > 0) {
    nano += cachedTokens * rate(pricing.cached || pricing.input) * NANO_PER_RATE_UNIT;
  }
  nano += outputTokens * rate(pricing.output) * NANO_PER_RATE_UNIT;
  if (reasoningTokens > 0) {
    nano += reasoningTokens * rate(pricing.reasoning || pricing.output) * NANO_PER_RATE_UNIT;
  }
  if (cacheCreationTokens > 0) {
    nano += cacheCreationTokens * rate(pricing.cache_creation || pricing.input) * NANO_PER_RATE_UNIT;
  }

  return Math.round(nano);
}
