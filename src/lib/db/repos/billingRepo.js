// Billing core: plans, orders, credit grants, FEFO charging, overdraft, ledger.
//
// Money is INTEGER nanoUSD everywhere (see shared/utils/money.js). No float
// arithmetic is performed on balances; floats exist only in display strings.
//
// Two layers live here on purpose:
//   * ASYNC functions that resolve the adapter themselves (walletSummary,
//     listPlans, approveOrder, ...) — used by routes and pages.
//   * SYNCHRONOUS functions that take the adapter as their first argument
//     (grantUserPlan, chargeCreditsSync, expireStalePlans). These are called
//     from inside an existing `db.transaction(fn)`, and the adapters expose a
//     synchronous transaction body only (better-sqlite3 and node:sqlite both
//     forbid awaiting inside one). Never await them.
//
// Ledger semantics
//   deltaNanoUsd          signed change to the customer's credit on book
//   balanceAfterNanoUsd   credit on book AFTER the entry:
//                         SUM(creditRemainingNanoUsd over status='active')
//                         minus users.overdraftNanoUsd. It can be negative
//                         while the account is in overdraft.
// "Available" (the number that gates requests and is shown in the wallet) is a
// different, narrower figure: active AND unexpired credit minus overdraft,
// floored at zero — see getAvailableNanoUsd.
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { stringifyJson, parseJson } from "../helpers/jsonCol.js";
import { hashApiKey } from "./apiKeysRepo.js";
import { fmtUsdNano } from "../../../shared/utils/money.js";
import {
  insertLedgerSync,
  bookBalanceNanoSync,
  getDebtNanoSync,
  setDebtNanoSync,
  nano,
} from "../../billing/ledger.js";
import { grantUserPlan, NO_PLAN_ID } from "../../billing/grants.js";
import {
  ORDER_SELECT,
  approveOrderSync,
  getOrderRowSync,
  orderLimits,
  rowToOrder,
} from "../../billing/orders.js";
import { chargeSync } from "../../billing/planQueue.js";
import { normalizeLimits, parseLimits, serializeLimits, validateLimits } from "../../billing/limits.js";

// Re-exported so every existing importer (giftRepo, localDb, db/index, tests)
// keeps working unchanged after the move to src/lib/billing/ (design D13).
export { grantUserPlan, NO_PLAN_ID };

const DAY_MS = 24 * 60 * 60 * 1000;
const PLAN_CODE_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

function nowIso() {
  return new Date().toISOString();
}

/**
 * `priceVnd` as stored: integer đồng, or NULL when the plan is not sold by VietQR.
 * Zero is stored as NULL because both mean the same thing ("no VND price") and one
 * representation keeps `priceVnd > 0` the single test for offering the method.
 */
function normalizePriceVnd(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// ── Wallet ────────────────────────────────────────────────────────────────

/** `null` when the value means "no plan", whichever placeholder the schema forced. */
function planIdOrNull(value) {
  if (value === null || value === undefined || value === NO_PLAN_ID) return null;
  return value;
}

function rowToUserPlan(row) {
  if (!row) return null;
  const total = nano(row.creditTotalNanoUsd);
  const remaining = nano(row.creditRemainingNanoUsd);
  return {
    id: row.id,
    planId: planIdOrNull(row.planId),
    planCode: row.planCode ?? null,
    planName: row.planName ?? null,
    creditTotalNanoUsd: total,
    creditRemainingNanoUsd: remaining,
    creditUsedNanoUsd: Math.max(0, total - remaining),
    startsAt: row.startsAt,
    expiresAt: row.expiresAt,
    status: row.status,
    source: row.source ?? null,
    orderId: row.orderId ?? null,
    createdAt: row.createdAt ?? null,
  };
}

const USER_PLAN_SELECT = `
  SELECT up.*, p.code AS planCode, p.name AS planName
    FROM userPlans up
    LEFT JOIN plans p ON p.id = up.planId`;

/**
 * Wallet headline + every plan row (including expired/exhausted, newest first).
 * `availableNanoUsd` only counts active AND unexpired credit, so an expired
 * plan that the janitor has not swept yet can never be spent.
 */
export async function walletSummary(userId) {
  if (!userId) throw new Error("walletSummary requires a userId");
  const db = await getAdapter();
  const now = nowIso();

  const rows = db.all(`${USER_PLAN_SELECT} WHERE up.userId = ? ORDER BY up.createdAt DESC, up.id DESC`, [userId]);
  const plans = rows.map(rowToUserPlan);
  const overdraftNanoUsd = getDebtNanoSync(db, userId);

  let liveCredit = 0;
  let totalGrantedNanoUsd = 0;
  for (const plan of plans) {
    totalGrantedNanoUsd += plan.creditTotalNanoUsd;
    if (plan.status === "active" && plan.expiresAt > now) liveCredit += plan.creditRemainingNanoUsd;
  }

  return {
    availableNanoUsd: Math.max(0, liveCredit - overdraftNanoUsd),
    liveCreditNanoUsd: liveCredit,
    overdraftNanoUsd,
    totalGrantedNanoUsd,
    plans,
  };
}

/** Same formula as walletSummary's headline, without materialising the plan list. */
export async function getAvailableNanoUsd(userId) {
  if (!userId) return 0;
  const db = await getAdapter();
  const row = db.get(
    `SELECT
       COALESCE((SELECT SUM(creditRemainingNanoUsd) FROM userPlans
                  WHERE userId = ? AND status = 'active' AND expiresAt > ?), 0) AS credit,
       COALESCE((SELECT overdraftNanoUsd FROM users WHERE id = ?), 0) AS overdraft`,
    [userId, nowIso(), userId]
  );
  const available = nano(row?.credit) - nano(row?.overdraft);
  return available > 0 ? available : 0;
}

// ── Grant ─────────────────────────────────────────────────────────────────

// ── Charge ────────────────────────────────────────────────────────────────

/**
 * Charge one request's cost against the customer's plan queue.
 * SYNCHRONOUS — must run inside the caller's db.transaction.
 *
 * A thin wrapper over the engine's chargeSync so existing callers and tests keep
 * working: the ordering, two-pass split and window bookkeeping all live in
 * src/lib/billing/planQueue.js (one implementation for admission, charging, the
 * UIs and admin actions).
 *
 * `now` is the legacy argument name; `usageId` is new.
 *
 * @returns {{ charged:number, alreadyCharged:boolean, parts:Array, fromPlans:Array, overdraftNanoUsd:number }}
 */
export function chargeCreditsSync(db, {
  userId,
  apiKeyId = null,
  usageId = null,
  requestKey,
  costNanoUsd = 0,
  now = null,
} = {}) {
  const result = chargeSync(db, {
    userId,
    apiKeyId,
    usageId,
    requestKey,
    costNanoUsd,
    nowIso: now,
  });
  return {
    charged: result.charged,
    alreadyCharged: result.alreadyCharged,
    parts: result.parts,
    // Legacy shape: [{ userPlanId, amount }] across both passes.
    fromPlans: result.parts.map((part) => ({ userPlanId: part.userPlanId, amount: part.amountNanoUsd })),
    overdraftNanoUsd: result.debtNanoUsd,
  };
}

// ── Expiry ────────────────────────────────────────────────────────────────

/**
 * Sweep plans that are past expiresAt but still marked active. SYNCHRONOUS.
 * The forfeited credit is written to the ledger (kind='expire') before the plan
 * is zeroed, so the audit trail shows exactly what was lost.
 *
 * @returns {{ expired: number, forfeitedNanoUsd: number }}
 */
export function expireStalePlans(db, now = nowIso()) {
  if (!db) throw new Error("expireStalePlans requires the db adapter");

  const rows = db.all(
    `SELECT id, userId, creditRemainingNanoUsd
       FROM userPlans
      WHERE status = 'active' AND expiresAt < ?
      ORDER BY expiresAt ASC`,
    [now]
  );

  let forfeitedNanoUsd = 0;
  for (const row of rows) {
    const remaining = nano(row.creditRemainingNanoUsd);
    db.run(`UPDATE userPlans SET status = 'expired', creditRemainingNanoUsd = 0 WHERE id = ?`, [row.id]);
    insertLedgerSync(db, {
      userId: row.userId,
      userPlanId: row.id,
      deltaNanoUsd: -remaining,
      kind: "expire",
      meta: { forfeitedNanoUsd: remaining },
      createdAt: now,
    });
    if (remaining > 0) forfeitedNanoUsd += remaining;
  }

  // Window state belongs to an active purchase only. Leaving rows behind after a
  // sweep would keep counting spend against a plan nobody can pay with, and a
  // later re-grant of the same row (an admin adjust back above zero on a plan that
  // is still `exhausted`) would inherit a stale window.
  db.run(
    `DELETE FROM userPlanWindows
      WHERE userPlanId IN (SELECT id FROM userPlans WHERE status <> 'active')`
  );

  return { expired: rows.length, forfeitedNanoUsd };
}

/** Async entry point for the janitor: resolves the adapter, then sweeps in one transaction. */
export async function runExpirySweep(now = nowIso()) {
  const db = await getAdapter();
  return db.transaction(() => expireStalePlans(db, now));
}

// ── Ledger read ───────────────────────────────────────────────────────────

function rowToLedgerEntry(row) {
  const meta = parseJson(row.meta, null);
  return {
    id: row.id,
    userId: row.userId,
    userPlanId: row.userPlanId ?? null,
    planName: row.planName ?? null,
    planCode: row.planCode ?? null,
    apiKeyId: row.apiKeyId ?? null,
    apiKeyName: row.apiKeyName ?? null,
    requestKey: row.requestKey ?? null,
    kind: row.kind,
    deltaNanoUsd: nano(row.deltaNanoUsd),
    deltaUsd: fmtUsdNano(nano(row.deltaNanoUsd)),
    balanceAfterNanoUsd: row.balanceAfterNanoUsd == null ? null : nano(row.balanceAfterNanoUsd),
    balanceAfterUsd: row.balanceAfterNanoUsd == null ? null : fmtUsdNano(nano(row.balanceAfterNanoUsd)),
    meta,
    createdAt: row.createdAt,
  };
}

/** Ledger page, newest first, with pre-formatted USD strings for the UI. */
export async function getLedger(userId, { limit = 100, offset = 0 } = {}) {
  if (!userId) throw new Error("getLedger requires a userId");
  const db = await getAdapter();
  const take = Math.min(Math.max(1, Math.floor(Number(limit) || 100)), 500);
  const skip = Math.max(0, Math.floor(Number(offset) || 0));

  const rows = db.all(
    `SELECT cl.*, p.name AS planName, p.code AS planCode, k.name AS apiKeyName
       FROM creditLedger cl
       LEFT JOIN userPlans up ON up.id = cl.userPlanId
       LEFT JOIN plans p ON p.id = up.planId
       LEFT JOIN apiKeys k ON k.id = cl.apiKeyId
      WHERE cl.userId = ?
      ORDER BY cl.createdAt DESC, cl.id DESC
      LIMIT ? OFFSET ?`,
    [userId, take, skip]
  );
  const total = nano(db.get(`SELECT COUNT(*) AS c FROM creditLedger WHERE userId = ?`, [userId])?.c);

  return { entries: rows.map(rowToLedgerEntry), total, limit: take, offset: skip };
}

// ── Plans CRUD ────────────────────────────────────────────────────────────

function rowToPlan(row) {
  if (!row) return null;
  // allowedGroupIds is a JSON array of keyGroups ids; null means "any group".
  // An empty array is normalised to null too: "no group selected" in the admin
  // form must mean unrestricted, not "nobody may buy" — the latter would make a
  // plan invisible with no hint as to why.
  const parsedGroups = parseJson(row.allowedGroupIds, null);
  const allowedGroupIds = Array.isArray(parsedGroups) && parsedGroups.length > 0
    ? parsedGroups.filter((g) => typeof g === "string")
    : null;
  return {
    id: row.id,
    code: row.code,
    name: row.name ?? null,
    description: row.description ?? null,
    priceNanoUsd: nano(row.priceNanoUsd),
    // Integer đồng, NULL when the plan is not sold by bank transfer.
    priceVnd: row.priceVnd == null ? null : nano(row.priceVnd),
    creditNanoUsd: nano(row.creditNanoUsd),
    durationDays: nano(row.durationDays),
    isActive: row.isActive === 1 || row.isActive === true,
    isPurchasable: row.isPurchasable == null ? true : row.isPurchasable === 1 || row.isPurchasable === true,
    allowedGroupIds,
    purchaseLimitPerMonth: row.purchaseLimitPerMonth == null ? null : nano(row.purchaseLimitPerMonth),
    isFeatured: row.isFeatured === 1 || row.isFeatured === true,
    sortOrder: row.sortOrder == null ? null : nano(row.sortOrder),
    // Per-window limits (empty array = none). Snapshotted into orders and grants.
    limits: parseLimits(row.limits),
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

/**
 * Vietnamese error for the limits part of a plan input, or null. Shared by
 * createPlan/updatePlan and by the admin route so the message matches the rule.
 */
export function validatePlanLimits(input = {}) {
  return validateLimits(input.limits ?? [], {
    creditNanoUsd: nano(input.creditNanoUsd),
    durationDays: nano(input.durationDays),
  });
}

/** Validation shared by the API route and any admin caller. Returns null when valid. */
export function validatePlanInput(input = {}) {
  const code = String(input.code ?? "").trim().toLowerCase();
  if (!PLAN_CODE_RE.test(code)) {
    return "code must be 2-32 chars of a-z, 0-9, _ or -, starting with a letter or digit";
  }
  if (!String(input.name ?? "").trim()) return "name is required";
  const price = Number(input.priceNanoUsd);
  if (!Number.isInteger(price) || price < 0) return "priceNanoUsd must be an integer >= 0";
  // priceVnd (spec plan-dual-pricing "Two prices per plan"): integer đồng, 0 or
  // empty when the plan is not sold by VietQR. A negative or fractional value is
  // refused here so the API answers 400 before anything is written.
  if (input.priceVnd !== undefined && input.priceVnd !== null && input.priceVnd !== "") {
    const priceVnd = Number(input.priceVnd);
    if (!Number.isInteger(priceVnd) || priceVnd < 0) {
      return "priceVnd must be a non-negative integer (đồng)";
    }
  }
  const credit = Number(input.creditNanoUsd);
  if (!Number.isInteger(credit) || credit <= 0) return "creditNanoUsd must be an integer > 0";
  const days = Number(input.durationDays);
  if (!Number.isInteger(days) || days < 1) return "durationDays must be an integer >= 1";

  // allowedGroupIds: null (anyone) or a non-empty array of group ids. An empty
  // array is rejected rather than coerced, because "restricted to nobody" is
  // never what an admin means and would look like a plan silently disappearing.
  if (input.allowedGroupIds !== undefined && input.allowedGroupIds !== null) {
    if (!Array.isArray(input.allowedGroupIds)) return "allowedGroupIds must be an array or null";
    if (input.allowedGroupIds.length === 0) {
      return "allowedGroupIds is empty — leave it null to allow every group";
    }
    if (!input.allowedGroupIds.every((g) => typeof g === "string" && g.trim())) {
      return "allowedGroupIds must contain non-empty group ids";
    }
  }

  // limits: validated against this plan's own credit and duration (spec
  // plan-templates "Limit validation"). Rejected before anything is written.
  const limitsError = validatePlanLimits(input);
  if (limitsError) return limitsError;

  // purchaseLimitPerMonth: null/0 = unlimited, otherwise a positive integer.
  if (input.purchaseLimitPerMonth !== undefined && input.purchaseLimitPerMonth !== null) {
    const limit = Number(input.purchaseLimitPerMonth);
    if (!Number.isInteger(limit) || limit < 0) {
      return "purchaseLimitPerMonth must be a non-negative integer (0 = unlimited)";
    }
  }
  return null;
}

/**
 * Per-plan figures for the admin table (spec plan-templates "Plan statistics" and
 * spec plan-dual-pricing "Revenue per currency").
 *
 * Three grouped queries over the whole set, never one per plan:
 *   activeCount / activeUsers   over userPlans rows with status 'active'
 *   revenueVnd                  sum of payAmount of paid orders paid in VND (đồng)
 *   revenueUsdNano              sum of paid orders paid in USDT or approved manually,
 *                               in nano-USD (1 USDT = 1 USD, no rate involved)
 *   revenueNanoUsd              the two USD-ish halves combined, kept for the
 *                               figures that predate the split
 *   consumedNanoUsd             sum of what was charged to the plan's purchases
 *
 * Refunded and every other non-paid status is excluded from both revenue figures.
 *
 * @returns {Map<string, {activeCount:number, activeUsers:number, revenueVnd:number,
 *          revenueUsdNano:number, revenueNanoUsd:number, consumedNanoUsd:number}>}
 */
export async function planStats() {
  const db = await getAdapter();
  const stats = new Map();
  const ensure = (planId) => {
    if (!stats.has(planId)) {
      stats.set(planId, {
        activeCount: 0,
        activeUsers: 0,
        revenueVnd: 0,
        revenueUsdNano: 0,
        revenueNanoUsd: 0,
        consumedNanoUsd: 0,
      });
    }
    return stats.get(planId);
  };

  // 1. Active purchases, and the distinct users holding them.
  const activeRows = db.all(
    `SELECT planId, COUNT(*) AS count, COUNT(DISTINCT userId) AS users
       FROM userPlans
      WHERE status = 'active' AND planId IS NOT NULL
      GROUP BY planId`
  );
  for (const row of activeRows) {
    const entry = ensure(row.planId);
    entry.activeCount = Number(row.count) || 0;
    entry.activeUsers = Number(row.users) || 0;
  }

  // 2. Revenue, split by the currency the customer actually paid in.
  //
  // One row per (plan, currency). `payCurrency` is snapshotted on the order, so a
  // later change to the plan's prices cannot rewrite what was collected. Orders
  // created before the split have a NULL payCurrency; they were all manual orders
  // priced in USD, which is why NULL falls into the USD bucket.
  //
  //   VND              → revenueVnd, in đồng (payAmount)
  //   USDT / USD / NULL → revenueUsdNano, in nano-USD (payAmount for USDT and USD
  //                      alike; amountNanoUsd as the fallback for a pre-split row)
  const revenueRows = db.all(
    `SELECT planId,
            CASE WHEN payCurrency = 'VND' THEN 'VND' ELSE 'USD' END AS bucket,
            COALESCE(SUM(
              CASE WHEN payCurrency = 'VND' THEN COALESCE(payAmount, 0)
                   ELSE COALESCE(payAmount, amountNanoUsd, 0)
              END
            ), 0) AS total
       FROM orders
      WHERE status = 'paid'
      GROUP BY planId, bucket`
  );
  for (const row of revenueRows) {
    const entry = ensure(row.planId);
    if (row.bucket === "VND") entry.revenueVnd = nano(row.total);
    else entry.revenueUsdNano = nano(row.total);
  }
  for (const entry of stats.values()) {
    entry.revenueNanoUsd = nano(entry.revenueUsdNano);
  }

  // 3. Consumed: everything charged against the plan's purchases, including
  //    expired ones — that credit was still delivered and spent.
  const consumedRows = db.all(
    `SELECT up.planId AS planId, COALESCE(SUM(-cl.deltaNanoUsd), 0) AS total
       FROM creditLedger cl
       JOIN userPlans up ON up.id = cl.userPlanId
      WHERE cl.kind = 'charge' AND up.planId IS NOT NULL
      GROUP BY up.planId`
  );
  for (const row of consumedRows) {
    ensure(row.planId).consumedNanoUsd = nano(row.total);
  }

  return stats;
}

/** Admin list: every plan, ordered for display. `onlyActive` filters the shop view. */
export async function listPlans({ onlyActive = false } = {}) {
  const db = await getAdapter();
  const where = onlyActive ? `WHERE isActive = 1` : "";
  const rows = db.all(
    `SELECT * FROM plans ${where} ORDER BY COALESCE(sortOrder, 999999) ASC, createdAt ASC`
  );
  return rows.map(rowToPlan);
}

export async function getPlanById(id) {
  if (!id) return null;
  const db = await getAdapter();
  return rowToPlan(db.get(`SELECT * FROM plans WHERE id = ?`, [id]));
}

export async function getPlanByCode(code) {
  if (!code) return null;
  const db = await getAdapter();
  return rowToPlan(db.get(`SELECT * FROM plans WHERE code = ?`, [String(code).trim().toLowerCase()]));
}

export async function createPlan(input = {}) {
  const error = validatePlanInput(input);
  if (error) throw new Error(error);
  const db = await getAdapter();
  const exists = db.get(`SELECT id FROM plans WHERE code = ?`, [String(input.code).trim().toLowerCase()]);
  if (exists) throw new Error("A plan with this code already exists");

  const now = nowIso();
  const plan = {
    id: uuidv4(),
    code: String(input.code).trim().toLowerCase(),
    name: String(input.name).trim(),
    description: input.description == null ? null : String(input.description),
    priceNanoUsd: nano(input.priceNanoUsd),
    priceVnd: normalizePriceVnd(input.priceVnd),
    creditNanoUsd: nano(input.creditNanoUsd),
    durationDays: nano(input.durationDays),
    isActive: input.isActive !== false,
    isPurchasable: input.isPurchasable !== false,
    allowedGroupIds: Array.isArray(input.allowedGroupIds) && input.allowedGroupIds.length > 0
      ? input.allowedGroupIds.map((g) => String(g).trim())
      : null,
    purchaseLimitPerMonth: input.purchaseLimitPerMonth == null || Number(input.purchaseLimitPerMonth) === 0
      ? null
      : nano(input.purchaseLimitPerMonth),
    isFeatured: input.isFeatured === true,
    sortOrder: input.sortOrder == null ? null : nano(input.sortOrder),
    limits: serializeLimits(input.limits ?? []),
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO plans(id, code, name, description, priceNanoUsd, priceVnd, creditNanoUsd, durationDays, isActive, isPurchasable, allowedGroupIds, purchaseLimitPerMonth, isFeatured, sortOrder, limits, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      plan.id, plan.code, plan.name, plan.description, plan.priceNanoUsd, plan.priceVnd, plan.creditNanoUsd,
      plan.durationDays, plan.isActive ? 1 : 0, plan.isPurchasable ? 1 : 0,
      plan.allowedGroupIds ? stringifyJson(plan.allowedGroupIds) : null,
      plan.purchaseLimitPerMonth, plan.isFeatured ? 1 : 0,
      plan.sortOrder, plan.limits, plan.createdAt, plan.updatedAt,
    ]
  );
  return rowToPlan(db.get(`SELECT * FROM plans WHERE id = ?`, [plan.id]));
}

/**
 * Plan update, split so a caller can run it INSIDE its own transaction.
 *
 * `updatePlanSync` does the validation and the write with no awaits, which is what
 * PATCH /api/plans/[id] needs to keep the template edit and the apply-to-active
 * pass atomic. `updatePlan` is the adapter-resolving wrapper every other caller
 * uses.
 *
 * @returns {null|object} the updated plan, or null when the plan is gone
 * @throws when the merged input is invalid
 */
export function updatePlanSync(db, id, patch = {}) {
  const current = rowToPlan(db.get(`SELECT * FROM plans WHERE id = ?`, [id]));
  if (!current) return null;

  const merged = { ...current, ...patch, updatedAt: nowIso() };
  const error = validatePlanInput(merged);
  if (error) throw new Error(error);

  const code = String(merged.code).trim().toLowerCase();
  const clash = db.get(`SELECT id FROM plans WHERE code = ? AND id != ?`, [code, id]);
  if (clash) throw new Error("A plan with this code already exists");

  db.run(
    `UPDATE plans SET code = ?, name = ?, description = ?, priceNanoUsd = ?, priceVnd = ?, creditNanoUsd = ?, durationDays = ?, isActive = ?, isPurchasable = ?, allowedGroupIds = ?, purchaseLimitPerMonth = ?, isFeatured = ?, sortOrder = ?, limits = ?, updatedAt = ? WHERE id = ?`,
    [
      code, String(merged.name).trim(),
      merged.description == null ? null : String(merged.description),
      nano(merged.priceNanoUsd), normalizePriceVnd(merged.priceVnd),
      nano(merged.creditNanoUsd), nano(merged.durationDays),
      merged.isActive ? 1 : 0, merged.isPurchasable ? 1 : 0,
      Array.isArray(merged.allowedGroupIds) && merged.allowedGroupIds.length > 0
        ? stringifyJson(merged.allowedGroupIds.map((g) => String(g).trim()))
        : null,
      merged.purchaseLimitPerMonth == null || Number(merged.purchaseLimitPerMonth) === 0
        ? null
        : nano(merged.purchaseLimitPerMonth),
      merged.isFeatured ? 1 : 0,
      merged.sortOrder == null ? null : nano(merged.sortOrder),
      serializeLimits(merged.limits ?? []),
      merged.updatedAt, id,
    ]
  );
  return rowToPlan(db.get(`SELECT * FROM plans WHERE id = ?`, [id]));
}

export async function updatePlan(id, patch = {}) {
  const db = await getAdapter();
  return updatePlanSync(db, id, patch);
}

/** Soft delete: existing orders and userPlans keep pointing at the row. */
export async function deletePlan(id) {
  const db = await getAdapter();
  const res = db.run(`UPDATE plans SET isActive = 0, updatedAt = ? WHERE id = ?`, [nowIso(), id]);
  return (res?.changes ?? 0) > 0;
}

// ── Orders ────────────────────────────────────────────────────────────────

// userEmail reads through to the account while it exists and falls back to the
// ORDER_SELECT, orderLimits and rowToOrder moved to src/lib/billing/orders.js
// (task 4.1) so the driver-free reconciliation engine can read an order without
// importing this adapter-resolving repo. Re-exported here because the existing
// importers and tests reach them through this module.
export { ORDER_SELECT, orderLimits, rowToOrder };

export async function listOrders({ status = null, userId = null, limit = 200, offset = 0 } = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (status) { where.push(`o.status = ?`); params.push(status); }
  if (userId) { where.push(`o.userId = ?`); params.push(userId); }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const take = Math.min(Math.max(1, Math.floor(Number(limit) || 200)), 500);
  const skip = Math.max(0, Math.floor(Number(offset) || 0));

  const rows = db.all(
    `${ORDER_SELECT} ${clause} ORDER BY o.createdAt DESC, o.id DESC LIMIT ? OFFSET ?`,
    [...params, take, skip]
  );
  const countRow = db.get(`SELECT COUNT(*) AS c FROM orders o ${clause}`, params);
  return { orders: rows.map(rowToOrder), total: Number(countRow?.c ?? 0) };
}

export async function getOrderById(id) {
  if (!id) return null;
  const db = await getAdapter();
  return rowToOrder(db.get(`${ORDER_SELECT} WHERE o.id = ?`, [id]));
}

/**
 * Create a pending manual order. Price/credit/duration are SNAPSHOTTED here so a
 * later plan edit cannot rewrite what a customer already agreed to pay.
 */
/**
 * Why this user may NOT buy this plan right now, or null when the purchase is
 * allowed.
 *
 * Two independent gates, both derived from the plan row:
 *  1. group membership — a plan can be restricted to specific keyGroups.
 *  2. per-month purchase count — counted over orders in the current calendar
 *     month, so a refunded/cancelled order re-opens the slot rather than
 *     permanently consuming it.
 *
 * Kept separate from createOrder so the catalogue route can ask the same
 * question without creating anything, and so the answer can be shown as a
 * reason on the pricing page instead of a mysterious 403 at checkout.
 */
export async function planPurchaseBlocker(db, plan, user, now = new Date()) {
  if (!plan) return { code: "not_found", reason: "Gói không tồn tại" };
  if (!plan.isActive) return { code: "inactive", reason: "Gói đã ngừng bán" };
  if (!plan.isPurchasable) return { code: "not_purchasable", reason: "Gói chưa mở bán" };

  if (Array.isArray(plan.allowedGroupIds) && plan.allowedGroupIds.length > 0) {
    const groupId = user?.groupId ?? null;
    if (!groupId || !plan.allowedGroupIds.includes(groupId)) {
      return { code: "group_restricted", reason: "Gói này chỉ dành cho một số nhóm người dùng" };
    }
  }

  const limit = nano(plan.purchaseLimitPerMonth ?? 0);
  if (limit > 0 && user?.id) {
    // Calendar month in UTC. A rolling 30-day window would be kinder but makes
    // the limit unpredictable ("why did it reset on the 3rd?"); calendar month
    // is what the admin wrote and what a customer can reason about.
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const row = db.get(
      // A cancelled or expired order never paid, so it must not consume the
      // month's slot (spec payment-checkout "Cancel and expiry").
      `SELECT COUNT(*) AS n FROM orders
        WHERE userId = ? AND planId = ? AND createdAt >= ? AND status NOT IN ('cancelled', 'expired')`,
      [user.id, plan.id, start]
    );
    const used = Number(row?.n ?? 0);
    if (used >= limit) {
      return {
        code: "purchase_limit",
        reason: `Gói này chỉ mua được ${limit} lần mỗi tháng (đã dùng ${used}/${limit})`,
        used,
        limit,
      };
    }
  }

  return null;
}

export async function createOrder({ userId, planId, payerNote = null, method = "manual" } = {}) {
  if (!userId) throw new Error("createOrder requires a userId");
  if (!planId) throw new Error("createOrder requires a planId");
  const db = await getAdapter();

  const plan = rowToPlan(db.get(`SELECT * FROM plans WHERE id = ?`, [planId]));
  if (!plan) throw new Error("Plan not found");

  // Buyability is decided in one place so the catalogue, the checkout button and
  // this call can never disagree about whether a plan may be bought.
  const user = db.get(`SELECT id, email, groupId FROM users WHERE id = ?`, [userId]);
  const blocker = await planPurchaseBlocker(db, plan, user);
  if (blocker) throw new Error(blocker.reason);

  const order = {
    id: uuidv4(),
    userId,
    planId: plan.id,
    amountNanoUsd: plan.priceNanoUsd,
    creditNanoUsd: plan.creditNanoUsd,
    durationDays: plan.durationDays,
    status: "pending",
    method: method || "manual",
    payerNote: payerNote == null || String(payerNote).trim() === "" ? null : String(payerNote).trim(),
    // The buyer's email at purchase time. Orders outlive the account (cascade
    // delete keeps them), so the address must live on the order too.
    emailSnapshot: user?.email ?? null,
    // Snapshot of the plan's limits: editing the plan afterwards must not rewrite
    // what the customer agreed to (spec plan-templates "Orders snapshot limits").
    limits: serializeLimits(plan.limits ?? []),
    createdAt: nowIso(),
  };
  db.run(
    `INSERT INTO orders(id, userId, planId, amountNanoUsd, creditNanoUsd, durationDays, status, method, payerNote, emailSnapshot, limits, createdAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      order.id, order.userId, order.planId, order.amountNanoUsd, order.creditNanoUsd,
      order.durationDays, order.status, order.method, order.payerNote, order.emailSnapshot,
      order.limits, order.createdAt,
    ]
  );
  return getOrderById(order.id);
}

export async function updateOrderStatus(id, { status, approvedBy = null, adminNote = null } = {}) {
  if (!status) throw new Error("updateOrderStatus requires a status");
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM orders WHERE id = ?`, [id]);
  if (!row) return null;
  db.run(
    `UPDATE orders SET status = ?, approvedBy = COALESCE(?, approvedBy), adminNote = COALESCE(?, adminNote) WHERE id = ?`,
    [status, approvedBy, adminNote, id]
  );
  return getOrderById(id);
}

/**
 * Mark an order paid and grant its credit, atomically. Idempotent: a second call
 * on an already-paid order reports it and grants nothing.
 *
 * The body moved to `src/lib/billing/orders.js` (task 4.1) so the payment
 * reconciliation engine can call it inside its own transaction; this wrapper only
 * resolves the adapter and opens the transaction.
 */
export async function approveOrder(id, adminId = null) {
  const db = await getAdapter();
  return db.transaction(() =>
    approveOrderSync(db, id, { approvedBy: adminId, now: nowIso() })
  );
}

/** Owner-only cancellation, pending orders only. */
export async function cancelOrder(id, userId) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM orders WHERE id = ?`, [id]);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.userId !== userId) return { ok: false, reason: "forbidden" };
  if (row.status !== "pending") return { ok: false, reason: "not_pending" };
  db.run(`UPDATE orders SET status = 'cancelled' WHERE id = ?`, [id]);
  return { ok: true, order: await getOrderById(id) };
}

/**
 * Refund a paid order: status becomes 'refunded', and — only if the order really
 * did grant a plan — the order's snapshotted credit is granted again on a fresh
 * window, recorded in the ledger as kind='refund' with a POSITIVE delta against
 * the same order.
 *
 * Note the direction: this returns credit to the customer. It is a credit
 * compensation attached to the order, not a clawback, so credit the customer has
 * already spent is restored rather than deducted. That is the requested
 * behaviour; an accounting reversal would instead post a negative delta for the
 * unconsumed remainder.
 */
export async function refundOrder(id, { adminId = null, adminNote = null } = {}) {
  const db = await getAdapter();
  return db.transaction(() => {
    const row = db.get(`SELECT * FROM orders WHERE id = ?`, [id]);
    if (!row) return null;
    if (row.status === "refunded") {
      return { alreadyRefunded: true, order: rowToOrder(row), userPlan: null, refundedNanoUsd: 0 };
    }
    if (row.status !== "paid") {
      throw new Error(`Cannot refund an order in status "${row.status}"`);
    }

    const granted = db.get(
      `SELECT id FROM userPlans WHERE orderId = ? ORDER BY createdAt ASC LIMIT 1`,
      [id]
    );
    const at = nowIso();

    db.run(
      `UPDATE orders SET status = 'refunded', adminNote = COALESCE(?, adminNote) WHERE id = ?`,
      [adminNote, id]
    );

    // No userPlans row for this order means nothing was ever granted, so there is
    // no credit to compensate: the status change alone is the correct outcome.
    let userPlan = null;
    let refundedNanoUsd = 0;
    let appliedToOverdraftNanoUsd = 0;
    if (granted) {
      const result = grantUserPlan(db, {
        userId: row.userId,
        planId: row.planId,
        orderId: id,
        source: "refund",
        creditNanoUsd: nano(row.creditNanoUsd),
        durationDays: nano(row.durationDays),
        limits: orderLimits(db, row),
        meta: { refundedOrderStatus: "paid", adminId, adminNote: adminNote ?? null },
        now: at,
        ledgerKind: "refund",
      });
      userPlan = result.userPlan;
      // The order's credit is what was compensated; the overdraft slice of it
      // never became spendable credit, so both figures are reported.
      refundedNanoUsd = nano(row.creditNanoUsd);
      appliedToOverdraftNanoUsd = result.appliedToOverdraftNanoUsd;
    }

    return {
      alreadyRefunded: false,
      order: rowToOrder(db.get(`${ORDER_SELECT} WHERE o.id = ?`, [id])),
      userPlan,
      refundedNanoUsd,
      appliedToOverdraftNanoUsd,
    };
  });
}

// ── API key owner resolution ──────────────────────────────────────────────

const OWNER_TTL_MS = 60 * 1000;
// Per-adapter cache: the adapter identity is the cache scope so a test adapter
// never answers for the production one. Still one map per process.
const ownerCaches = new WeakMap();

function ownerCacheFor(db) {
  let cache = ownerCaches.get(db);
  if (!cache) {
    cache = new Map();
    ownerCaches.set(db, cache);
  }
  return cache;
}

/**
 * `{ userId, apiKeyId }` for a raw api key string, or null when the key is not a
 * tenant key (legacy keys have no userId; those are not billed). Synchronous and
 * cached for 60s per key string, because the post-charge hook runs on every
 * request and this lookup is otherwise a duplicate of what auth just did.
 */
export function resolveApiKeyOwner(db, apiKey) {
  if (!db || !apiKey) return null;
  const cache = ownerCacheFor(db);
  const hit = cache.get(apiKey);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  let value = null;
  try {
    let row = db.get(`SELECT id, userId FROM apiKeys WHERE key = ?`, [apiKey]);
    if (!row) {
      const hash = hashApiKey(apiKey);
      if (hash) row = db.get(`SELECT id, userId FROM apiKeys WHERE keyHash = ?`, [hash]);
    }
    if (row?.userId) value = { userId: row.userId, apiKeyId: row.id };
  } catch {
    return null;
  }

  cache.set(apiKey, { value, expiresAt: Date.now() + OWNER_TTL_MS });
  // Bounded: a long-running process sees a handful of keys per customer, but cap
  // anyway so a key-rotation loop cannot grow this without limit.
  if (cache.size > 1000) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return value;
}
