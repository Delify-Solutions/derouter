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

const DAY_MS = 24 * 60 * 60 * 1000;
const PLAN_CODE_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

// Placeholder written into userPlans.planId while the schema still declares that
// column NOT NULL, for a credit-only grant that genuinely has no plan (a gift
// code with grantKind='credit'). "" is never a real plans.id, so every join
// misses it and the plan reads as absent — same presentation as a NULL. Once the
// column is nullable (migration 003), the probe below inserts real NULLs and this
// value stops being written.
export const NO_PLAN_ID = "";

function nowIso() {
  return new Date().toISOString();
}

// Integer nanoUSD from anything numeric. Never returns NaN, never returns a float.
function nano(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : 0;
}

// Does userPlans.planId allow NULL? Probed once per adapter and cached: the
// column definition cannot change under a live connection except via a migration,
// and a migration replaces the process's DB anyway. Reading the constraint beats
// guessing, because the INSERT is inside a caller's transaction — an exception
// there would poison their work.
const planIdNullableByAdapter = new WeakMap();

function planIdIsNullable(db) {
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

/** `null` when the value means "no plan", whichever placeholder the schema forces. */
function planIdOrNull(value) {
  if (value === null || value === undefined || value === NO_PLAN_ID) return null;
  return value;
}

function isoPlusDays(days, from = Date.now()) {
  const d = Math.max(1, Math.floor(Number(days) || 0));
  return new Date(from + d * DAY_MS).toISOString();
}

// ── Credit on book (the ledger's running balance) ──────────────────────────
// One round trip: the two sub-selects share a single statement. Scoped by
// userId, and idx_up_user covers the plan side.
function bookBalanceNano(db, userId) {
  const row = db.get(
    `SELECT
       COALESCE((SELECT SUM(creditRemainingNanoUsd) FROM userPlans
                  WHERE userId = ? AND status = 'active'), 0) AS credit,
       COALESCE((SELECT overdraftNanoUsd FROM users WHERE id = ?), 0) AS overdraft`,
    [userId, userId]
  );
  return nano(row?.credit) - nano(row?.overdraft);
}

function getUserOverdraftNano(db, userId) {
  const row = db.get(`SELECT COALESCE(overdraftNanoUsd, 0) AS o FROM users WHERE id = ?`, [userId]);
  return nano(row?.o);
}

function setUserOverdraftNano(db, userId, value) {
  db.run(`UPDATE users SET overdraftNanoUsd = ? WHERE id = ?`, [Math.max(0, nano(value)), userId]);
}

/**
 * Insert one ledger row. `requestKey` stays NULL unless the caller passes one;
 * SQLite allows many NULLs under a UNIQUE index, which is what non-idempotent
 * grant/adjust/expire rows want.
 */
function insertLedger(db, entry) {
  const createdAt = entry.createdAt || nowIso();
  const balance = entry.balanceAfterNanoUsd != null
    ? nano(entry.balanceAfterNanoUsd)
    : bookBalanceNano(db, entry.userId);
  db.run(
    `INSERT INTO creditLedger(userId, userPlanId, apiKeyId, requestKey, deltaNanoUsd, balanceAfterNanoUsd, kind, meta, createdAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.userId,
      entry.userPlanId ?? null,
      entry.apiKeyId ?? null,
      entry.requestKey ?? null,
      nano(entry.deltaNanoUsd),
      balance,
      entry.kind,
      entry.meta == null ? null : stringifyJson(entry.meta),
      createdAt,
    ]
  );
}

// ── Wallet ────────────────────────────────────────────────────────────────

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
  const overdraftNanoUsd = getUserOverdraftNano(db, userId);

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

/**
 * Create a userPlans row for a purchase/gift/admin grant.
 * SYNCHRONOUS — call inside an existing db.transaction. The granted credit first
 * repays whatever the account owes (users.overdraftNanoUsd); only the remainder
 * lands on the new plan, so a grant can never leave a user both funded and in
 * debt.
 *
 * @returns {{ userPlan: object, appliedToOverdraftNanoUsd: number }}
 */
export function grantUserPlan(db, {
  userId,
  planId = null,
  orderId = null,
  source,
  creditNanoUsd,
  durationDays,
  meta = null,
  now = null,
  // Ledger kind for the credit entry. A refund is still a grant of credit, but it
  // has to be auditable as its own event, not as a second 'grant'.
  ledgerKind = "grant",
} = {}) {
  if (!db) throw new Error("grantUserPlan requires the db adapter");
  if (!userId) throw new Error("grantUserPlan requires a userId");
  if (!source) throw new Error("grantUserPlan requires a source");

  const credit = Math.max(0, nano(creditNanoUsd));
  const startsAt = now || nowIso();
  const expiresAt = isoPlusDays(durationDays, new Date(startsAt).getTime());

  // 1. Repay overdraft out of the granted credit.
  const overdraftBefore = getUserOverdraftNano(db, userId);
  const paydown = Math.min(credit, overdraftBefore);
  if (paydown > 0) {
    setUserOverdraftNano(db, userId, overdraftBefore - paydown);
    insertLedger(db, {
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
    startsAt,
    expiresAt,
    status: "active",
    createdAt: startsAt,
  };

  db.run(
    `INSERT INTO userPlans(id, userId, planId, orderId, source, creditTotalNanoUsd, creditRemainingNanoUsd, startsAt, expiresAt, status, createdAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userPlan.id, userPlan.userId, userPlan.planId, userPlan.orderId, userPlan.source,
      userPlan.creditTotalNanoUsd, userPlan.creditRemainingNanoUsd,
      userPlan.startsAt, userPlan.expiresAt, userPlan.status, userPlan.createdAt,
    ]
  );

  insertLedger(db, {
    userId,
    userPlanId: userPlan.id,
    deltaNanoUsd: planCredit,
    kind: ledgerKind,
    meta: meta && typeof meta === "object"
      ? { ...meta, source, orderId, planId, appliedToOverdraftNanoUsd: paydown }
      : { source, orderId, planId, appliedToOverdraftNanoUsd: paydown },
    createdAt: startsAt,
  });

  return { userPlan, appliedToOverdraftNanoUsd: paydown };
}

// ── Charge ────────────────────────────────────────────────────────────────

/**
 * Charge one request's cost against the customer's credit, FEFO (first expiring,
 * first out). SYNCHRONOUS — must run inside the caller's db.transaction.
 *
 * Idempotent on `requestKey`: the first ledger row of a charge carries the exact
 * key, follow-up rows carry `key#2`, `key#3`, ... (the UNIQUE index permits only
 * one row per key, but a charge that spans three plans must still be auditable
 * per plan). Because the base row is written in the same transaction as every
 * sibling, its presence is a sound "this request was already billed" marker.
 *
 * A cost of 0 writes nothing: there is nothing to double-bill, and a zero-value
 * row would only add noise to the customer's ledger.
 */
export function chargeCreditsSync(db, {
  userId,
  apiKeyId = null,
  requestKey,
  costNanoUsd = 0,
  now = null,
} = {}) {
  if (!db) throw new Error("chargeCreditsSync requires the db adapter");
  if (!userId) throw new Error("chargeCreditsSync requires a userId");

  const existing = requestKey
    ? db.get(`SELECT id FROM creditLedger WHERE requestKey = ?`, [requestKey])
    : null;
  if (existing) {
    return { charged: 0, alreadyCharged: true, fromPlans: [], overdraftNanoUsd: getUserOverdraftNano(db, userId) };
  }

  const cost = Math.max(0, nano(costNanoUsd));
  if (cost === 0) {
    return { charged: 0, alreadyCharged: false, fromPlans: [], overdraftNanoUsd: getUserOverdraftNano(db, userId) };
  }

  const at = now || nowIso();
  const plans = db.all(
    `SELECT id, creditRemainingNanoUsd, expiresAt
       FROM userPlans
      WHERE userId = ? AND status = 'active' AND expiresAt > ? AND creditRemainingNanoUsd > 0
      ORDER BY expiresAt ASC, createdAt ASC`,
    [userId, at]
  );

  const fromPlans = [];
  let remaining = cost;
  let ledgerRows = 0;

  for (const plan of plans) {
    if (remaining <= 0) break;
    const available = nano(plan.creditRemainingNanoUsd);
    if (available <= 0) continue;

    const take = Math.min(available, remaining);
    const left = available - take;
    if (left === 0) {
      db.run(`UPDATE userPlans SET creditRemainingNanoUsd = 0, status = 'exhausted' WHERE id = ?`, [plan.id]);
    } else {
      db.run(`UPDATE userPlans SET creditRemainingNanoUsd = ? WHERE id = ?`, [left, plan.id]);
    }

    insertLedger(db, {
      userId,
      userPlanId: plan.id,
      apiKeyId,
      requestKey: ledgerRows === 0 ? requestKey ?? null : `${requestKey}#${ledgerRows + 1}`,
      deltaNanoUsd: -take,
      kind: "charge",
      createdAt: at,
    });
    ledgerRows += 1;
    remaining -= take;
    fromPlans.push({ userPlanId: plan.id, amount: take });
  }

  // Cost exceeded every plan: the tail becomes overdraft debt.
  if (remaining > 0) {
    const overdraftBefore = getUserOverdraftNano(db, userId);
    setUserOverdraftNano(db, userId, overdraftBefore + remaining);
    insertLedger(db, {
      userId,
      userPlanId: null,
      apiKeyId,
      requestKey: ledgerRows === 0 ? requestKey ?? null : `${requestKey}#${ledgerRows + 1}`,
      deltaNanoUsd: -remaining,
      kind: "charge",
      meta: { overdraft: true },
      createdAt: at,
    });
    ledgerRows += 1;
    remaining = 0;
  }

  return {
    charged: cost,
    alreadyCharged: false,
    fromPlans,
    overdraftNanoUsd: getUserOverdraftNano(db, userId),
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
    insertLedger(db, {
      userId: row.userId,
      userPlanId: row.id,
      deltaNanoUsd: -remaining,
      kind: "expire",
      meta: { forfeitedNanoUsd: remaining },
      createdAt: now,
    });
    if (remaining > 0) forfeitedNanoUsd += remaining;
  }

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
  return {
    id: row.id,
    code: row.code,
    name: row.name ?? null,
    description: row.description ?? null,
    priceNanoUsd: nano(row.priceNanoUsd),
    creditNanoUsd: nano(row.creditNanoUsd),
    durationDays: nano(row.durationDays),
    isActive: row.isActive === 1 || row.isActive === true,
    sortOrder: row.sortOrder == null ? null : nano(row.sortOrder),
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
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
  const credit = Number(input.creditNanoUsd);
  if (!Number.isInteger(credit) || credit <= 0) return "creditNanoUsd must be an integer > 0";
  const days = Number(input.durationDays);
  if (!Number.isInteger(days) || days < 1) return "durationDays must be an integer >= 1";
  return null;
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
    creditNanoUsd: nano(input.creditNanoUsd),
    durationDays: nano(input.durationDays),
    isActive: input.isActive !== false,
    sortOrder: input.sortOrder == null ? null : nano(input.sortOrder),
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO plans(id, code, name, description, priceNanoUsd, creditNanoUsd, durationDays, isActive, sortOrder, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      plan.id, plan.code, plan.name, plan.description, plan.priceNanoUsd, plan.creditNanoUsd,
      plan.durationDays, plan.isActive ? 1 : 0, plan.sortOrder, plan.createdAt, plan.updatedAt,
    ]
  );
  return plan;
}

export async function updatePlan(id, patch = {}) {
  const db = await getAdapter();
  const current = rowToPlan(db.get(`SELECT * FROM plans WHERE id = ?`, [id]));
  if (!current) return null;

  const merged = { ...current, ...patch, updatedAt: nowIso() };
  const error = validatePlanInput(merged);
  if (error) throw new Error(error);

  const code = String(merged.code).trim().toLowerCase();
  const clash = db.get(`SELECT id FROM plans WHERE code = ? AND id != ?`, [code, id]);
  if (clash) throw new Error("A plan with this code already exists");

  db.run(
    `UPDATE plans SET code = ?, name = ?, description = ?, priceNanoUsd = ?, creditNanoUsd = ?, durationDays = ?, isActive = ?, sortOrder = ?, updatedAt = ? WHERE id = ?`,
    [
      code, String(merged.name).trim(),
      merged.description == null ? null : String(merged.description),
      nano(merged.priceNanoUsd), nano(merged.creditNanoUsd), nano(merged.durationDays),
      merged.isActive ? 1 : 0, merged.sortOrder == null ? null : nano(merged.sortOrder),
      merged.updatedAt, id,
    ]
  );
  return rowToPlan(db.get(`SELECT * FROM plans WHERE id = ?`, [id]));
}

/** Soft delete: existing orders and userPlans keep pointing at the row. */
export async function deletePlan(id) {
  const db = await getAdapter();
  const res = db.run(`UPDATE plans SET isActive = 0, updatedAt = ? WHERE id = ?`, [nowIso(), id]);
  return (res?.changes ?? 0) > 0;
}

// ── Orders ────────────────────────────────────────────────────────────────

const ORDER_SELECT = `
  SELECT o.*, u.email AS userEmail, u.displayName AS userDisplayName,
         p.code AS planCode, p.name AS planName
    FROM orders o
    LEFT JOIN users u ON u.id = o.userId
    LEFT JOIN plans p ON p.id = o.planId`;

function rowToOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    planId: row.planId,
    amountNanoUsd: nano(row.amountNanoUsd),
    creditNanoUsd: nano(row.creditNanoUsd),
    durationDays: nano(row.durationDays),
    status: row.status,
    method: row.method ?? "manual",
    payerNote: row.payerNote ?? null,
    adminNote: row.adminNote ?? null,
    approvedBy: row.approvedBy ?? null,
    createdAt: row.createdAt ?? null,
    paidAt: row.paidAt ?? null,
    userEmail: row.userEmail ?? null,
    userDisplayName: row.userDisplayName ?? null,
    planCode: row.planCode ?? null,
    planName: row.planName ?? null,
  };
}

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
export async function createOrder({ userId, planId, payerNote = null, method = "manual" } = {}) {
  if (!userId) throw new Error("createOrder requires a userId");
  if (!planId) throw new Error("createOrder requires a planId");
  const db = await getAdapter();

  const plan = rowToPlan(db.get(`SELECT * FROM plans WHERE id = ?`, [planId]));
  if (!plan) throw new Error("Plan not found");
  if (!plan.isActive) throw new Error("Plan is not available");

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
    createdAt: nowIso(),
  };
  db.run(
    `INSERT INTO orders(id, userId, planId, amountNanoUsd, creditNanoUsd, durationDays, status, method, payerNote, createdAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      order.id, order.userId, order.planId, order.amountNanoUsd, order.creditNanoUsd,
      order.durationDays, order.status, order.method, order.payerNote, order.createdAt,
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
 */
export async function approveOrder(id, adminId = null) {
  const db = await getAdapter();
  return db.transaction(() => {
    const row = db.get(`SELECT * FROM orders WHERE id = ?`, [id]);
    if (!row) return null;
    if (row.status === "paid" || row.status === "refunded") {
      return { alreadyApproved: true, order: rowToOrder(row), userPlan: null, appliedToOverdraftNanoUsd: 0 };
    }
    if (row.status !== "pending") {
      throw new Error(`Cannot approve an order in status "${row.status}"`);
    }

    const paidAt = nowIso();
    db.run(
      `UPDATE orders SET status = 'paid', paidAt = ?, approvedBy = COALESCE(?, approvedBy) WHERE id = ?`,
      [paidAt, adminId, id]
    );

    const granted = grantUserPlan(db, {
      userId: row.userId,
      planId: row.planId,
      orderId: id,
      source: "purchase",
      creditNanoUsd: nano(row.creditNanoUsd),
      durationDays: nano(row.durationDays),
      meta: { orderId: id, amountNanoUsd: nano(row.amountNanoUsd) },
      now: paidAt,
    });

    return {
      alreadyApproved: false,
      order: rowToOrder(db.get(`${ORDER_SELECT} WHERE o.id = ?`, [id])),
      userPlan: granted.userPlan,
      appliedToOverdraftNanoUsd: granted.appliedToOverdraftNanoUsd,
    };
  });
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
