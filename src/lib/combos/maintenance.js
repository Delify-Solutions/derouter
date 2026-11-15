// The combo option "maintenance" (spec api-access-enforcement): combos.meta.maintenance === true.
// Pure helpers shared by the combo routes, the key enforcement and the model lists;
// relative imports only. Same shape as cacheEstimation.js.

export const MAINTENANCE_ERROR = "maintenance must be true or false";

/** True only for a combo that explicitly has the flag on (absent, false or junk = off). */
export function comboIsInMaintenance(combo) {
  return combo?.meta?.maintenance === true;
}

/** Validate an API value: undefined (not sent) and booleans are fine, anything else is not. */
export function isValidMaintenanceInput(value) {
  return value === undefined || typeof value === "boolean";
}

/** meta with the flag set (true stores the key, false removes it so old combos stay identical). */
export function withMaintenance(meta, enabled) {
  const next = { ...(meta && typeof meta === "object" ? meta : {}) };
  if (enabled === true) next.maintenance = true; else delete next.maintenance;
  return next;
}
