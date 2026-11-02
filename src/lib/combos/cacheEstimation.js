// The combo option "estimated cache" (spec usage-accuracy): combos.meta.cacheEstimation === true.
// Pure helpers shared by the combo routes and the chat handler; relative imports only.

export const CACHE_ESTIMATION_ERROR = "cacheEstimation must be true or false";

/** True only for a combo that explicitly has the option on (absent, false or junk = off). */
export function comboHasCacheEstimation(combo) {
  return combo?.meta?.cacheEstimation === true;
}

/** Validate an API value: undefined (not sent) and booleans are fine, anything else is not. */
export function isValidCacheEstimationInput(value) {
  return value === undefined || typeof value === "boolean";
}

/** meta with the option set (true stores the key, false removes it so old combos stay identical). */
export function withCacheEstimation(meta, enabled) {
  const next = { ...(meta && typeof meta === "object" ? meta : {}) };
  if (enabled === true) next.cacheEstimation = true; else delete next.cacheEstimation;
  return next;
}
