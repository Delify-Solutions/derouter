// Which models a customer may call, read from the database (spec plan-model-access).
//
// The rule itself is pure and lives in `planModels.js`; this module is the one place
// that reads the rows it needs, so enforcement, the model listings and the account
// page cannot disagree about what a customer is allowed.
//
// Reads one indexed query. It deliberately does NOT reuse listQueueSync: that one
// also loads every window row, which admission needs and model scope does not.
import { hasStarted } from "./planQueue.js";
import { effectiveModels, normalizePlanModels, unionOfModels } from "./planModels.js";

/**
 * The model union over a customer's live purchases.
 *
 * "Live" mirrors admission: `active`, started, unexpired. A purchase that has not
 * started yet (later period of a multi-period term) pays for nothing, so it must not
 * advertise access either.
 *
 * @returns {{ union: string[]|null, liveCount: number }}
 *          union null = no live purchase, or all of them unrestricted
 */
export function livePurchaseModelsSync(db, userId, nowIsoArg = null) {
  const empty = { union: null, liveCount: 0 };
  if (!db || !userId) return empty;
  const at = nowIsoArg || new Date().toISOString();
  const nowMs = new Date(at).getTime();
  const rows = db.all(
    `SELECT allowedModels, startsAt FROM userPlans
      WHERE userId = ? AND status = 'active' AND expiresAt > ?`,
    [userId, at]
  );
  const live = rows
    .filter((row) => hasStarted({ startsAt: row.startsAt }, nowMs))
    .map((row) => ({ allowedModels: normalizePlanModels(row.allowedModels) }));
  if (live.length === 0) return empty;
  return { union: unionOfModels(live), liveCount: live.length };
}

/**
 * The effective allow-list for a customer: the group's list narrowed by the live
 * purchases' lists.
 *
 * @param {object} db adapter
 * @param {string} userId
 * @param {string[]|null} groupAllowed the group's allow-list (null/[] = everything)
 * @param {string|null} nowIso
 * @returns {string[]|null} null = unrestricted; [] = nothing callable; else exactly those
 */
export function customerModelScopeSync(db, userId, groupAllowed, nowIso = null) {
  const { union } = livePurchaseModelsSync(db, userId, nowIso);
  return effectiveModels(groupAllowed, union);
}
