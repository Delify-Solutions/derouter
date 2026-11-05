// The request/token rate a customer is held to right now (spec plan-templates
// "Plan request and token rates").
//
// RPM/TPM are read live from the plan of the purchase that is PAYING now (the one
// admission would pick) and counted over every key of the customer. Enforcement
// and every screen that shows a rate call this one function, so a page can never
// show a limit the request path does not apply.
//
// Relative imports only: tests import this under plain `node --test`.
import { admitSync, effectiveRate, rateKeyOf } from "./planQueue.js";

/**
 * The rate is the paying purchase's own override when it has one, else its plan's
 * (spec plan-templates "Per-purchase rate override"). Allowances are counted per
 * `rateKey` (see getUserRateUsage and ratePlanIdSync): the plan id, or the purchase
 * for a planless purchase with an override. null rateKey = nothing to count.
 *
 * @returns {{ userPlanId: string|null, planId: string|null, planName: string|null,
 *             rateKey: string|null, rpm: number|null, tpm: number|null }}
 *          null rpm/tpm = no limit (no paying plan, or none set)
 */
export function payingRatesSync(db, userId, nowIso = null, { planId = null } = {}) {
  const none = { userPlanId: null, planId: null, planName: null, rateKey: null, rpm: null, tpm: null };
  if (!db || !userId) return none;
  // `planId` = the plan a pinned key is paid by; omitted = the head of the queue.
  const admitted = admitSync(db, userId, nowIso, { planId });
  if (!admitted.ok) return none;
  const row = db.get(
    `SELECT up.id AS id, up.planId AS planId, up.rpm AS rpm, up.tpm AS tpm,
            p.name AS name, p.code AS code, p.rpm AS planRpm, p.tpm AS planTpm
       FROM userPlans up LEFT JOIN plans p ON p.id = up.planId
      WHERE up.id = ?`,
    [admitted.planId]
  );
  return {
    userPlanId: admitted.planId,
    planId: row?.planId ?? null,
    planName: row?.name || row?.code || null,
    rateKey: rateKeyOf(row),
    rpm: effectiveRate(row?.rpm, row?.planRpm),
    tpm: effectiveRate(row?.tpm, row?.planTpm),
  };
}
