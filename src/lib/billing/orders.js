// Order records and the one path that approves them.
//
// Extracted from `billingRepo.approveOrder` (design D2 / task 4.1) so the
// reconciliation engine — which is driver-free and imported by tests under plain
// `node --test` — can approve an order without importing an adapter-resolving repo.
//
// `approveOrderSync` is the idempotency boundary for money: it refuses any order
// that is not `pending` (or `expired` when the caller is an admin resolving a late
// payment), INSIDE the caller's write transaction. A webhook delivered twice, a
// webhook and a poll racing, or two admins clicking at once therefore cannot grant
// the same order twice.
//
// Relative imports only. Never import ../db/driver.js or any repo that does.
import { grantUserPlan } from "./grants.js";
import { nano } from "./ledger.js";
import { parseLimits, serializeLimits } from "./limits.js";
import { parseJson } from "../db/helpers/jsonCol.js";

function nowIso() {
  return new Date().toISOString();
}

// userEmail reads through to the account while it exists and falls back to the
// snapshot after a cascade delete, so an order row stays readable for accounting
// even when its buyer is gone.
export const ORDER_SELECT = `
  SELECT o.*, COALESCE(u.email, o.emailSnapshot) AS userEmail, u.displayName AS userDisplayName,
         p.code AS planCode, p.name AS planName
    FROM orders o
    LEFT JOIN users u ON u.id = o.userId
    LEFT JOIN plans p ON p.id = o.planId`;

/**
 * The limits an order should grant: its own snapshot when it has one, otherwise
 * the plan's current limits (orders created before GĐ1).
 */
export function orderLimits(db, orderRow) {
  const snapshot = parseLimits(orderRow.limits);
  if (snapshot.length > 0) return snapshot;
  const plan = orderRow.planId ? db.get(`SELECT limits FROM plans WHERE id = ?`, [orderRow.planId]) : null;
  return parseLimits(plan?.limits);
}

/** One order row (already joined by ORDER_SELECT) in the API/UI shape. */
export function rowToOrder(row) {
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
    // Gateway payment fields (design D1). NULL for a manual order, which pays no
    // provider and therefore carries no code, currency or expiry.
    paymentCode: row.paymentCode ?? null,
    payCurrency: row.payCurrency ?? null,
    payAmount: row.payAmount == null ? null : nano(row.payAmount),
    paymentProviderId: row.paymentProviderId ?? null,
    expiresAt: row.expiresAt ?? null,
    paymentTransactionId: row.paymentTransactionId ?? null,
    payerNote: row.payerNote ?? null,
    adminNote: row.adminNote ?? null,
    approvedBy: row.approvedBy ?? null,
    createdAt: row.createdAt ?? null,
    paidAt: row.paidAt ?? null,
    userEmail: row.userEmail ?? null,
    userDisplayName: row.userDisplayName ?? null,
    planCode: row.planCode ?? null,
    planName: row.planName ?? null,
    limits: parseLimits(row.limits),
  };
}

/**
 * An order as its BUYER may see it: a whitelist, not a blacklist, so a column added
 * to `rowToOrder` later stays private until someone decides it should not.
 * Left out on purpose: `adminNote` and `approvedBy` (admin identity and internal
 * notes), `paymentProviderId` / `paymentTransactionId` (which receiving account and
 * which bank transaction), `userId`, the e-mail/name join and the limits snapshot.
 * Accepts the `rowToOrder` shape and the leaner `readGatewayOrder` shape.
 */
export function toCustomerOrder(order) {
  if (!order) return null;
  return {
    id: order.id,
    planId: order.planId ?? null,
    planCode: order.planCode ?? null,
    planName: order.planName ?? null,
    amountNanoUsd: order.amountNanoUsd,
    creditNanoUsd: order.creditNanoUsd,
    durationDays: order.durationDays,
    status: order.status,
    method: order.method ?? "manual",
    paymentCode: order.paymentCode ?? null,
    payCurrency: order.payCurrency ?? null,
    payAmount: order.payAmount ?? null,
    expiresAt: order.expiresAt ?? null,
    payerNote: order.payerNote ?? null,
    createdAt: order.createdAt ?? null,
    paidAt: order.paidAt ?? null,
  };
}

/** Read one order in the joined shape. `null` when it does not exist. */
export function getOrderRowSync(db, orderId) {
  if (!orderId) return null;
  return db.get(`${ORDER_SELECT} WHERE o.id = ?`, [orderId]);
}

/**
 * Mark an order paid and grant its plan. SYNCHRONOUS — call inside a transaction.
 *
 * Refuses (throws) when the order is not in an approvable status, which is what
 * makes a repeated payment delivery harmless: the second caller sees `paid` and
 * gets `alreadyApproved` (or, from `ingestTransactionSync`, `order_not_pending`).
 *
 * @param {object} db adapter
 * @param {string} orderId
 * @param {{ approvedBy?: string|null, now?: string|null, paymentTransactionId?: string|null,
 *           allowExpired?: boolean }} options
 * @returns {{alreadyApproved: boolean, order: object, userPlan: object|null,
 *            appliedToOverdraftNanoUsd: number, paidAt: string|null}|null}
 */
export function approveOrderSync(db, orderId, {
  approvedBy = null,
  now = null,
  paymentTransactionId = null,
  allowExpired = false,
} = {}) {
  if (!db) throw new Error("approveOrderSync requires the db adapter");
  if (!orderId) throw new Error("approveOrderSync requires an orderId");

  const row = getOrderRowSync(db, orderId);
  if (!row) return null;

  if (row.status === "paid" || row.status === "refunded") {
    return {
      alreadyApproved: true,
      order: rowToOrder(row),
      userPlan: null,
      appliedToOverdraftNanoUsd: 0,
      paidAt: row.paidAt ?? null,
    };
  }

  const allowed = row.status === "pending" || (allowExpired && row.status === "expired");
  if (!allowed) throw new Error(`Cannot approve an order in status "${row.status}"`);

  const paidAt = now || nowIso();

  // Status in the WHERE clause as well as the check above: the statement then
  // cannot mark an order paid after another writer changed it, even if a driver
  // ever runs these statements outside the serialized write path.
  const result = db.run(
    `UPDATE orders
        SET status = 'paid', paidAt = ?, approvedBy = COALESCE(?, approvedBy), paymentTransactionId = COALESCE(?, paymentTransactionId)
      WHERE id = ? AND status IN ('pending'${allowExpired ? ", 'expired'" : ""})`,
    [paidAt, approvedBy, paymentTransactionId, orderId]
  );
  if (result && typeof result.changes === "number" && result.changes === 0) {
    // Lost the race: re-read and answer as "already handled" so the caller's
    // transaction can still commit the rest of its work (e.g. the transaction row).
    const current = getOrderRowSync(db, orderId);
    return {
      alreadyApproved: true,
      order: rowToOrder(current),
      userPlan: null,
      appliedToOverdraftNanoUsd: 0,
      paidAt: current?.paidAt ?? null,
    };
  }

  const granted = grantUserPlan(db, {
    userId: row.userId,
    planId: row.planId,
    orderId,
    source: "purchase",
    creditNanoUsd: nano(row.creditNanoUsd),
    durationDays: nano(row.durationDays),
    // The snapshot taken at order time; an order created before GĐ1 has none and
    // falls back to the plan's current limits, which is the only thing it could
    // possibly mean.
    limits: orderLimits(db, row),
    meta: { orderId, amountNanoUsd: nano(row.amountNanoUsd), paymentTransactionId },
    now: paidAt,
  });

  return {
    alreadyApproved: false,
    order: rowToOrder(getOrderRowSync(db, orderId)),
    userPlan: granted.userPlan,
    appliedToOverdraftNanoUsd: granted.appliedToOverdraftNanoUsd,
    paidAt,
  };
}

/**
 * Snapshot of what an order grants, taken from the plan at creation time
 * (spec payment-checkout: "Plan credit, duration and limits are snapshotted as for
 * any order"). One place so the manual path and the gateway path cannot disagree.
 */
export function orderSnapshot(plan) {
  return {
    amountNanoUsd: nano(plan.priceNanoUsd),
    creditNanoUsd: nano(plan.creditNanoUsd),
    durationDays: nano(plan.durationDays),
    limits: serializeLimits(plan.limits ?? []),
  };
}

/** JSON body of a plan's limits as stored on an order — tolerant of both shapes. */
export function snapshotLimitsOf(plan) {
  if (typeof plan?.limits === "string") return plan.limits;
  return serializeLimits(plan?.limits ?? []);
}

export { parseJson };
