// The request/token rate a customer is held to right now (spec plan-templates
// "Plan request and token rates").
//
// RPM/TPM are read live from the plan of the purchase that is PAYING now (the one
// admission would pick) and counted over every key of the customer. Enforcement
// and every screen that shows a rate call this one function, so a page can never
// show a limit the request path does not apply.
//
// Relative imports only: tests import this under plain `node --test`.
import { admitSync } from "./planQueue.js";

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * RPM/TPM allowances are counted per (user, plan): callers count usage with the
 * returned `planId` (see getUserRateUsage).
 *
 * @returns {{ userPlanId: string|null, planId: string|null, planName: string|null,
 *             rpm: number|null, tpm: number|null }}
 *          null rpm/tpm = no limit (no paying plan, or the plan sets none)
 */
export function payingRatesSync(db, userId, nowIso = null, { planId = null, productLine = "api" } = {}) {
  const none = { userPlanId: null, planId: null, planName: null, rpm: null, tpm: null };
  if (!db || !userId) return none;
  // `planId` = the plan a pinned key is paid by; omitted = the head of the queue.
  // `productLine` = the key's line: a bot key is paid by business purchases only.
  const admitted = admitSync(db, userId, nowIso, { planId, productLine });
  if (!admitted.ok) return none;
  const row = db.get(
    `SELECT p.id AS planId, p.name AS name, p.code AS code, p.rpm AS rpm, p.tpm AS tpm
       FROM userPlans up JOIN plans p ON p.id = up.planId
      WHERE up.id = ?`,
    [admitted.planId]
  );
  return {
    userPlanId: admitted.planId,
    planId: row?.planId ?? null,
    planName: row?.name || row?.code || null,
    rpm: positive(row?.rpm),
    tpm: positive(row?.tpm),
  };
}
