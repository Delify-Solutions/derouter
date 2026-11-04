// Commission accrual, release and reversal (design D2, D3, D4).
//
// SYNCHRONOUS + DRIVER-FREE. Every function takes the adapter first and runs
// inside the caller's transaction, so an approval/refund and the commission it
// causes commit or roll back together. Relative imports only; never import
// ../../db/driver.js or a repo that does.
//
// Money is integer: đồng for VND, nano-USD for USD (USDT is taken 1:1 as nano-USD,
// the same rule planStats uses for revenue). No float arithmetic anywhere; the
// rate multiplication goes through BigInt because nano-USD × 10000 can exceed 2^53.
import { v4 as uuidv4 } from "uuid";
import { insertAuditSync } from "../billing/audit.js";
import { stringifyJson } from "../db/helpers/jsonCol.js";
import { readAffiliateSettingsSync } from "./settings.js";
import { getAffiliateSync, effectiveTermsSync } from "./core.js";

function nowIso() {
  return new Date().toISOString();
}

function addDays(iso, days) {
  const base = Date.parse(iso);
  const ms = (Number.isFinite(base) ? base : Date.now()) + Math.max(0, Number(days) || 0) * 86_400_000;
  return new Date(ms).toISOString();
}

/**
 * `floor(base × rateBp / 10000)` in exact integer arithmetic.
 * BigInt division truncates toward zero; both operands are non-negative here, so
 * truncation IS floor. The result is clamped to a safe integer because every
 * balance in the system is one.
 */
export function commissionAmount(base, rateBp) {
  const b = BigInt(Math.trunc(Number(base) || 0));
  const r = BigInt(Math.trunc(Number(rateBp) || 0));
  if (b <= 0n || r <= 0n) return 0;
  const amount = (b * r) / 10_000n;
  if (amount <= 0n) return 0;
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  return Number(amount > max ? max : amount);
}

/**
 * The currency and base amount of an order, by the rule planStats uses for
 * revenue (spec "Commission currency and base amount"):
 *
 *   VND          → đồng, `payAmount`
 *   USDT         → nano-USD, `payAmount` (1 USDT = 1 USD)
 *   USD / NULL   → nano-USD, `payAmount` else `amountNanoUsd`
 */
export function commissionBaseOf(orderRow) {
  if (String(orderRow?.payCurrency || "") === "VND") {
    const payAmount = Math.trunc(Number(orderRow.payAmount ?? 0));
    return { currency: "VND", baseAmount: payAmount > 0 ? payAmount : 0 };
  }
  const payAmount = orderRow?.payAmount == null ? null : Math.trunc(Number(orderRow.payAmount));
  const base = payAmount != null && payAmount > 0
    ? payAmount
    : Math.trunc(Number(orderRow?.amountNanoUsd ?? 0));
  return { currency: "USD", baseAmount: base > 0 ? base : 0 };
}

function insertLedgerSync(db, { userId, currency, delta, kind, commissionId = null, withdrawalId = null, meta = null, now }) {
  db.run(
    `INSERT INTO affiliateLedger(userId, currency, delta, kind, commissionId, withdrawalId, meta, createdAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, currency, delta, kind, commissionId, withdrawalId, meta == null ? null : stringifyJson(meta), now]
  );
}

/**
 * Record the commission an order earns, if it earns one (design D2 steps 1–7).
 *
 * Called from `approveOrderSync` ONLY on the path that actually marks the order
 * paid, inside that transaction. `orderId UNIQUE` makes a second call a no-op even
 * if two approval paths race.
 *
 * @param {object} db adapter
 * @param {object} orderRow raw `orders` row (needs userId, id, payCurrency, payAmount, amountNanoUsd)
 * @param {{ now?: string, settings?: object }} options
 * @returns {object|null} the inserted commission row, or null when nothing accrues
 */
export function accrueCommissionSync(db, orderRow, { now = null, settings = null } = {}) {
  if (!db) throw new Error("accrueCommissionSync requires the db adapter");
  if (!orderRow?.id || !orderRow?.userId) return null;

  // 1. The buyer and its referrer. No referrer, or a self-referral: stop.
  const buyer = db.get(`SELECT id, referredByUserId FROM users WHERE id = ?`, [orderRow.userId]);
  if (!buyer?.referredByUserId) return null;
  const referrerId = buyer.referredByUserId;
  if (referrerId === buyer.id) return null;

  // 2. Program switch.
  const s = settings || readAffiliateSettingsSync(db);
  if (s.affiliateEnabled !== true) return null;

  // 3. Referrer must still exist and must not be blocked.
  const affiliate = getAffiliateSync(db, referrerId);
  if (!affiliate) return null;
  if (affiliate.status !== "active") return null;
  const referrer = db.get(`SELECT id FROM users WHERE id = ?`, [referrerId]);
  if (!referrer) return null;

  // 4. Effective terms.
  const terms = effectiveTermsSync(affiliate, s);

  // 5. First N PAID orders of this buyer (spec "First N orders per referred
  //    customer"). Counted over the buyer's orders, not over commissions: an
  //    order paid while the program was off, while the referrer was blocked or
  //    before an admin set the referrer still used up its place, so unblocking
  //    an affiliate cannot turn the buyer's 6th order into a "first" one. This
  //    order is already `paid` here, hence `id != ?`. A refunded order has status
  //    'refunded' and so frees its place for the next one.
  if (terms.maxOrders > 0) {
    const earlier = Number(
      db.get(
        `SELECT COUNT(*) AS n FROM orders
          WHERE userId = ? AND status = 'paid' AND id != ?`,
        [buyer.id, orderRow.id]
      )?.n ?? 0
    );
    if (earlier >= terms.maxOrders) return null;
  }

  // 6. Currency and base amount. A zero amount earns nothing.
  const { currency, baseAmount } = commissionBaseOf(orderRow);
  if (baseAmount <= 0) return null;
  const amount = commissionAmount(baseAmount, terms.rateBp);
  if (amount <= 0) return null;

  // 7. Insert. `holdDays` is fixed now, so changing the setting later cannot
  //    shorten or extend a commission already recorded.
  const at = now || nowIso();
  const holdDays = Number(s.affiliateHoldDays ?? 0);
  const availableAt = addDays(at, holdDays);
  const immediatelyAvailable = holdDays === 0;
  const id = uuidv4();

  const result = db.run(
    `INSERT INTO affiliateCommissions(
       id, orderId, affiliateUserId, referredUserId, currency, baseAmount, rateBp, amount,
       status, availableAt, releasedAt, reversedAt, createdAt
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT(orderId) DO NOTHING`,
    [
      id,
      orderRow.id,
      referrerId,
      buyer.id,
      currency,
      baseAmount,
      terms.rateBp,
      amount,
      immediatelyAvailable ? "available" : "pending",
      availableAt,
      immediatelyAvailable ? at : null,
      at,
    ]
  );
  if (result && typeof result.changes === "number" && result.changes === 0) {
    // Another approval of the same order won. Exactly one commission per order.
    return null;
  }

  if (immediatelyAvailable) {
    insertLedgerSync(db, {
      userId: referrerId,
      currency,
      delta: amount,
      kind: "commission",
      commissionId: id,
      meta: { orderId: orderRow.id, rateBp: terms.rateBp },
      now: at,
    });
  }

  return db.get(`SELECT * FROM affiliateCommissions WHERE id = ?`, [id]) ?? null;
}

/**
 * Release one due pending commission row (design D3). Shared by both variants so
 * the status guard, the ledger row and the timestamps cannot diverge.
 */
function releaseRowSync(db, row, now) {
  const result = db.run(
    `UPDATE affiliateCommissions SET status = 'available', releasedAt = ?
      WHERE id = ? AND status = 'pending'`,
    [now, row.id]
  );
  if (result && typeof result.changes === "number" && result.changes === 0) return 0;
  insertLedgerSync(db, {
    userId: row.affiliateUserId,
    currency: row.currency,
    delta: Number(row.amount),
    kind: "commission",
    commissionId: row.id,
    meta: { orderId: row.orderId },
    now,
  });
  return 1;
}

/**
 * Release this affiliate's due commissions. Called inside every wallet read and
 * every withdrawal request, so no background job is needed (design D3).
 *
 * @returns {number} rows released
 */
export function releaseDueSync(db, userId, now = null) {
  if (!db) throw new Error("releaseDueSync requires the db adapter");
  if (!userId) return 0;
  const at = now || nowIso();
  const rows = db.all(
    `SELECT c.* FROM affiliateCommissions c
      WHERE c.affiliateUserId = ? AND c.status = 'pending' AND c.availableAt <= ?
        AND EXISTS (SELECT 1 FROM users u WHERE u.id = c.affiliateUserId)`,
    [userId, at]
  );
  let released = 0;
  for (const row of rows) released += releaseRowSync(db, row, at);
  return released;
}

/**
 * Release every due commission. The admin list sums balances across many
 * affiliates, so it pays for one query rather than one per row.
 */
export function releaseAllDueSync(db, now = null) {
  if (!db) throw new Error("releaseAllDueSync requires the db adapter");
  const at = now || nowIso();
  // A deleted affiliate's held commission stays pending for accounting but is
  // never released: its wallet went with the account (design D10).
  const rows = db.all(
    `SELECT c.* FROM affiliateCommissions c
      WHERE c.status = 'pending' AND c.availableAt <= ?
        AND EXISTS (SELECT 1 FROM users u WHERE u.id = c.affiliateUserId)`,
    [at]
  );
  let released = 0;
  for (const row of rows) released += releaseRowSync(db, row, at);
  return released;
}

/**
 * Reverse the commission of a refunded order (design D4), inside the refund's
 * transaction: a pending one simply never pays; an available one takes a negative
 * ledger entry, which may push the balance below zero by design.
 *
 * @param {object} db adapter
 * @param {string} orderId
 * @param {{ now?: string, actor?: string, reason?: string|null }} options
 * @returns {{ reversed: boolean, row: object|null, amount: number }}
 */
export function reverseCommissionForOrderSync(db, orderId, { now = null, actor = "system", reason = null } = {}) {
  if (!db) throw new Error("reverseCommissionForOrderSync requires the db adapter");
  if (!orderId) return { reversed: false, row: null, amount: 0 };

  const row = db.get(`SELECT * FROM affiliateCommissions WHERE orderId = ?`, [orderId]);
  if (!row || row.status === "reversed") return { reversed: false, row: row ?? null, amount: 0 };

  const at = now || nowIso();
  const result = db.run(
    `UPDATE affiliateCommissions SET status = 'reversed', reversedAt = ?
      WHERE id = ? AND status IN ('pending', 'available')`,
    [at, row.id]
  );
  if (result && typeof result.changes === "number" && result.changes === 0) {
    return { reversed: false, row, amount: 0 };
  }

  const amount = Number(row.amount);
  if (row.status === "available") {
    insertLedgerSync(db, {
      userId: row.affiliateUserId,
      currency: row.currency,
      delta: -amount,
      kind: "reversal",
      commissionId: row.id,
      meta: { orderId, reason },
      now: at,
    });
  }

  insertAuditSync(db, {
    userId: row.affiliateUserId,
    actor,
    action: "affiliate_commission_reversed",
    reason,
    details: {
      commissionId: row.id,
      orderId,
      currency: row.currency,
      amount,
      fromStatus: row.status,
    },
    now: at,
  });

  return {
    reversed: true,
    row: db.get(`SELECT * FROM affiliateCommissions WHERE id = ?`, [row.id]) ?? null,
    amount,
  };
}
