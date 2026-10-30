// Granting a purchased plan — the one path that creates credit.
//
// Every grant (order approval, refund compensation, plan gift, credit gift, admin
// grant) funnels through grantUserPlan so they cannot disagree about debt paydown,
// ledger shape or the limits snapshot.
//
// Moved out of billingRepo.js (design D13) so the driver-free engine and the admin
// actions can call it without importing an adapter-resolving module (D8).
import { v4 as uuidv4 } from "uuid";
import { insertLedgerSync, getDebtNanoSync, setDebtNanoSync, nano } from "./ledger.js";
import { serializeLimits } from "./limits.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// Placeholder written into userPlans.planId while the schema still declares that
// column NOT NULL, for a credit-only grant that genuinely has no plan (a gift code
// with grantKind='credit'). "" is never a real plans.id, so every join misses it
// and the plan reads as absent — same presentation as a NULL. Once the column is
// nullable (migration 003), the probe below inserts real NULLs and this value
// stops being written.
export const NO_PLAN_ID = "";

function nowIso() {
  return new Date().toISOString();
}

export function isoPlusDays(days, from = Date.now()) {
  const d = Math.max(1, Math.floor(Number(days) || 0));
  return new Date(from + d * DAY_MS).toISOString();
}

// Does userPlans.planId allow NULL? Probed once per adapter and cached: the column
// definition cannot change under a live connection except via a migration, and a
// migration replaces the process's DB anyway. Reading the constraint beats
// guessing, because the INSERT is inside a caller's transaction — an exception
// there would poison their work.
const planIdNullableByAdapter = new WeakMap();

export function planIdIsNullable(db) {
  const cached = planIdNullableByAdapter.get(db);
  if (cached !== undefined) return cached;
  let nullable = true;
  try {
    const cols = db.all(`PRAGMA table_info(userPlans)`);
    const col = cols.find((c) => c.name === "planId");
    // No table/column (fresh DB before sync) → let the INSERT decide.
    nullable = !col || !col.notnull;
  } catch {
    nullable = true;
  }
  planIdNullableByAdapter.set(db, nullable);
  return nullable;
}

/**
 * Close an ACTIVE purchase without spending it: status becomes `status`
 * (`refunded`, `revoked`), the unspent credit is zeroed, its window counters go,
 * and the forfeited amount is written as one negative `revoke` ledger row so the
 * money stays accounted for. A plan that is not active is left alone.
 *
 * @returns {number} nano-USD removed (0 when nothing was left or the plan was closed)
 */
export function closeUserPlanSync(db, plan, { status, reason, meta = {}, now = null } = {}) {
  if (!plan || plan.status !== "active") return 0;
  const at = now || nowIso();
  const remaining = nano(plan.creditRemainingNanoUsd);

  db.run(`UPDATE userPlans SET status = ?, creditRemainingNanoUsd = 0 WHERE id = ?`, [status, plan.id]);
  db.run(`DELETE FROM userPlanWindows WHERE userPlanId = ?`, [plan.id]);

  if (remaining > 0) {
    insertLedgerSync(db, {
      userId: plan.userId,
      userPlanId: plan.id,
      deltaNanoUsd: -remaining,
      kind: "revoke",
      meta: { reason, ...meta },
      createdAt: at,
    });
  }
  return remaining;
}

/**
 * Create a userPlans row for a purchase/gift/admin grant.
 * SYNCHRONOUS — call inside an existing db.transaction.
 *
 * The granted credit first repays whatever the account owes
 * (users.overdraftNanoUsd); only the remainder lands on the new plan, so a grant
 * can never leave a user both funded and in debt.
 *
 * `unlimitedCredit` grants a plan with no credit ceiling: both credit columns are
 * 0 and nothing is repaid out of it, so an existing debt stays on the account (the
 * plan never runs dry, so admission does not look at the debt).
 *
 * `limits` is the normalised/serialisable snapshot of the plan's per-window limits
 * (spec plan-queue-billing "Each grant creates an independent purchased plan").
 * Credit-only grants pass `[]`. `priority` is always NULL: a new plan joins the
 * queue at its expiry position, never ahead of an order the customer chose.
 *
 * @returns {{ userPlan: object, appliedToOverdraftNanoUsd: number }}
 */
export function grantUserPlan(db, {
  userId,
  planId = null,
  orderId = null,
  source,
  creditNanoUsd,
  unlimitedCredit = false,
  durationDays,
  limits = [],
  meta = null,
  now = null,
  // Ledger kind for the credit entry. A refund is still a grant of credit, but it
  // has to be auditable as its own event, not as a second 'grant'.
  ledgerKind = "grant",
} = {}) {
  if (!db) throw new Error("grantUserPlan requires the db adapter");
  if (!userId) throw new Error("grantUserPlan requires a userId");
  if (!source) throw new Error("grantUserPlan requires a source");

  const unlimited = unlimitedCredit === true || Number(unlimitedCredit) === 1;
  const credit = unlimited ? 0 : Math.max(0, nano(creditNanoUsd));
  const startsAt = now || nowIso();
  const expiresAt = isoPlusDays(durationDays, new Date(startsAt).getTime());

  // 1. Repay overdraft out of the granted credit.
  const overdraftBefore = getDebtNanoSync(db, userId);
  const paydown = Math.min(credit, overdraftBefore);
  if (paydown > 0) {
    setDebtNanoSync(db, userId, overdraftBefore - paydown);
    insertLedgerSync(db, {
      userId,
      userPlanId: null,
      deltaNanoUsd: paydown,
      kind: "adjust",
      meta: { reason: "overdraft_paydown", source, orderId, planId, appliedToOverdraftNanoUsd: paydown },
      createdAt: startsAt,
    });
  }

  // 2. The remainder becomes the plan's credit.
  const planCredit = credit - paydown;
  const planIdValue = planId != null && planId !== NO_PLAN_ID
    ? planId
    : planIdIsNullable(db) ? null : NO_PLAN_ID;
  const userPlan = {
    id: uuidv4(),
    userId,
    planId: planIdValue,
    orderId,
    source,
    creditTotalNanoUsd: planCredit,
    creditRemainingNanoUsd: planCredit,
    unlimitedCredit: unlimited ? 1 : 0,
    startsAt,
    expiresAt,
    status: "active",
    priority: null,
    limits: serializeLimits(limits),
    createdAt: startsAt,
  };

  db.run(
    `INSERT INTO userPlans(id, userId, planId, orderId, source, creditTotalNanoUsd, creditRemainingNanoUsd, unlimitedCredit, startsAt, expiresAt, status, priority, limits, createdAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userPlan.id, userPlan.userId, userPlan.planId, userPlan.orderId, userPlan.source,
      userPlan.creditTotalNanoUsd, userPlan.creditRemainingNanoUsd, userPlan.unlimitedCredit,
      userPlan.startsAt, userPlan.expiresAt, userPlan.status, userPlan.priority,
      userPlan.limits, userPlan.createdAt,
    ]
  );

  insertLedgerSync(db, {
    userId,
    userPlanId: userPlan.id,
    deltaNanoUsd: planCredit,
    kind: ledgerKind,
    meta: meta && typeof meta === "object"
      ? { ...meta, source, orderId, planId, appliedToOverdraftNanoUsd: paydown, ...(unlimited ? { unlimited: true } : {}) }
      : { source, orderId, planId, appliedToOverdraftNanoUsd: paydown, ...(unlimited ? { unlimited: true } : {}) },
    createdAt: startsAt,
  });

  return { userPlan, appliedToOverdraftNanoUsd: paydown };
}
