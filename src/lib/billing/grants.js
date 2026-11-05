// Granting a purchased plan — the one path that creates credit.
//
// Every grant (order approval, refund compensation, plan gift, credit gift, admin
// grant) funnels through grantUserPlan so they cannot disagree about debt paydown,
// ledger shape or the limits snapshot.
//
// Moved out of billingRepo.js (design D13) so the driver-free engine and the admin
// actions can call it without importing an adapter-resolving module (D8).
import { v4 as uuidv4 } from "uuid";
import { insertLedgerSync, getDebtNanoSync, setDebtNanoSync, writeOffDebtSync, nano } from "./ledger.js";
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
 * When a new grant of this plan may start (spec plan-terms "Unlimited plans of the
 * same plan never overlap").
 *
 * Two unlimited purchases of the SAME plan running side by side would double its
 * window limits — the customer would get twice the plan for the overlap. So an
 * unlimited grant starts when the last still-active unlimited purchase of that plan
 * ends; anything else (a finite plan, a different plan, nothing running) starts now.
 */
export function stackedStartMsSync(db, { userId, planId, unlimited, nowMs }) {
  if (!unlimited || !planId || planId === NO_PLAN_ID) return nowMs;
  const row = db.get(
    `SELECT MAX(expiresAt) AS lastEnd FROM userPlans
      WHERE userId = ? AND planId = ? AND unlimitedCredit = 1 AND status = 'active' AND expiresAt > ?`,
    [userId, planId, new Date(nowMs).toISOString()]
  );
  const lastEndMs = row?.lastEnd ? new Date(row.lastEnd).getTime() : NaN;
  return Number.isFinite(lastEndMs) && lastEndMs > nowMs ? lastEndMs : nowMs;
}

/**
 * Create the userPlans rows for a purchase/gift/admin grant.
 * SYNCHRONOUS — call inside an existing db.transaction.
 *
 * `periods` (default 1) grants that many back-to-back purchases of `durationDays`
 * each: period k starts when period k−1 ends, and each has the full credit and its
 * own limits (spec plan-terms "A term grants back-to-back periods"). A later period
 * is `active` with a future `startsAt` and pays for nothing until then.
 *
 * The granted credit first repays whatever the account owes
 * (users.overdraftNanoUsd); only the remainder lands on the new plan, so a grant
 * can never leave a user both funded and in debt. With several periods the debt is
 * repaid from the first period's credit, then the next.
 *
 * `unlimitedCredit` grants a plan with no credit ceiling: both credit columns are
 * 0, and the plan takes over the account's whole existing debt, which is written
 * off (change debt-clear; reported as appliedToOverdraftNanoUsd). An unlimited grant
 * is queued behind any running unlimited purchase of the same plan
 * (`stackedStartMsSync`).
 *
 * `limits` is the normalised/serialisable snapshot of the plan's per-window limits
 * (spec plan-queue-billing "Each grant creates an independent purchased plan").
 * Credit-only grants pass `[]`. `priority` is always NULL: a new plan joins the
 * queue at its expiry position, never ahead of an order the customer chose.
 *
 * @returns {{ userPlan: object, userPlans: object[], appliedToOverdraftNanoUsd: number }}
 *          `userPlan` is the first period.
 */
export function grantUserPlan(db, {
  userId,
  planId = null,
  orderId = null,
  source,
  creditNanoUsd,
  unlimitedCredit = false,
  durationDays,
  periods = 1,
  limits = [],
  // Per-purchase RPM/TPM override (userPlans.rpm/tpm): null = the plan's own,
  // 0 = no limit, > 0 = this rate. A gift code passes its own.
  rpm = null,
  tpm = null,
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
  const count = Math.max(1, Math.floor(Number(periods) || 1));
  // When the grant happens: the ledger rows, createdAt and the overdraft paydown
  // are dated now even when the first period starts later.
  const at = now || nowIso();
  const planIdValue = planId != null && planId !== NO_PLAN_ID
    ? planId
    : planIdIsNullable(db) ? null : NO_PLAN_ID;

  const atMs = new Date(at).getTime();
  let startMs = stackedStartMsSync(db, { userId, planId: planIdValue, unlimited, nowMs: atMs });
  const userPlans = [];
  let appliedToOverdraftNanoUsd = 0;
  for (let index = 0; index < count; index += 1) {
    const granted = insertPeriodSync(db, {
      userId, planIdValue, orderId, source, unlimited, limits, meta, ledgerKind,
      rpm: rateOverride(rpm), tpm: rateOverride(tpm),
      credit: unlimited ? 0 : Math.max(0, nano(creditNanoUsd)),
      // Keep the caller's own timestamp string when the period starts right away.
      startsAt: startMs === atMs ? at : new Date(startMs).toISOString(),
      durationDays,
      at,
      period: count > 1 ? { index: index + 1, of: count } : null,
    });
    userPlans.push(granted.userPlan);
    appliedToOverdraftNanoUsd += granted.paydown;
    startMs = new Date(granted.userPlan.expiresAt).getTime();
  }

  return { userPlan: userPlans[0], userPlans, appliedToOverdraftNanoUsd };
}

/** One period of a grant: debt paydown, the userPlans row and its ledger row. */
/** A stored rate override: null (follow the plan) or a non-negative integer. */
function rateOverride(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error("RPM/TPM must be a non-negative integer");
  return n;
}

function insertPeriodSync(db, {
  userId, planIdValue, orderId, source, unlimited, limits, meta, ledgerKind,
  rpm = null, tpm = null, credit, startsAt, durationDays, at, period,
}) {
  const planId = planIdValue;
  const expiresAt = isoPlusDays(durationDays, new Date(startsAt).getTime());

  // 1. Repay overdraft out of the granted credit.
  const overdraftBefore = getDebtNanoSync(db, userId);
  let paydown = Math.min(credit, overdraftBefore);
  if (paydown > 0) {
    setDebtNanoSync(db, userId, overdraftBefore - paydown);
    insertLedgerSync(db, {
      userId,
      userPlanId: null,
      deltaNanoUsd: paydown,
      kind: "adjust",
      meta: { reason: "overdraft_paydown", source, orderId, planId, appliedToOverdraftNanoUsd: paydown },
      createdAt: at,
    });
  }

  // 2. The remainder becomes the plan's credit.
  const planCredit = credit - paydown;
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
    rpm,
    tpm,
    createdAt: at,
  };

  db.run(
    `INSERT INTO userPlans(id, userId, planId, orderId, source, creditTotalNanoUsd, creditRemainingNanoUsd, unlimitedCredit, startsAt, expiresAt, status, priority, limits, rpm, tpm, createdAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userPlan.id, userPlan.userId, userPlan.planId, userPlan.orderId, userPlan.source,
      userPlan.creditTotalNanoUsd, userPlan.creditRemainingNanoUsd, userPlan.unlimitedCredit,
      userPlan.startsAt, userPlan.expiresAt, userPlan.status, userPlan.priority,
      userPlan.limits, userPlan.rpm, userPlan.tpm, userPlan.createdAt,
    ]
  );

  // An unlimited plan takes over all older debt (change debt-clear).
  if (unlimited) {
    paydown += writeOffDebtSync(db, userId, {
      userPlanId: userPlan.id,
      meta: { reason: "overdraft_absorbed", source, orderId, planId },
      createdAt: at,
    });
  }

  const extra = {
    ...(unlimited ? { unlimited: true } : {}),
    ...(period ? { period: period.index, periods: period.of } : {}),
    ...(startsAt !== at ? { startsAt } : {}),
  };
  insertLedgerSync(db, {
    userId,
    userPlanId: userPlan.id,
    deltaNanoUsd: planCredit,
    kind: ledgerKind,
    meta: meta && typeof meta === "object"
      ? { ...meta, source, orderId, planId, appliedToOverdraftNanoUsd: paydown, ...extra }
      : { source, orderId, planId, appliedToOverdraftNanoUsd: paydown, ...extra },
    createdAt: at,
  });

  return { userPlan, paydown };
}
