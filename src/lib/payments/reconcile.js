// Reconciliation: one path from "money arrived" to "order approved" (design D4).
//
// Every caller — the SePay webhook, each poller, the admin dry run and the tests —
// goes through `ingestTransactionSync`. That is what makes the invariants hold:
//
//   * a transaction is stored EXACTLY once (UNIQUE providerId+externalId);
//   * an order is approved EXACTLY once (`approveOrderSync` refuses a non-pending
//     order, and the check happens inside the same write transaction);
//   * anything that cannot be matched is KEPT as needs_review with one reason, so
//     the admin can decide instead of the money disappearing.
//
// SYNCHRONOUS + DRIVER-FREE (design D2): callers pass the adapter and this module
// never imports ../db/driver.js, so `node --test` can load it directly.
//
// Relative imports only.
import { v4 as uuidv4 } from "uuid";
import { approveOrderSync, getOrderRowSync } from "../billing/orders.js";
import { insertAuditSync } from "../billing/audit.js";
import { nano } from "../billing/ledger.js";
import { stringifyJson, parseJson } from "../db/helpers/jsonCol.js";
import { extractCandidateCodes } from "./codes.js";

/** How far before an order's creation a payment may still belong to it. */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;

const REASONS = new Set([
  "no_code",
  "order_not_found",
  "wrong_provider",
  "order_not_pending",
  "order_expired",
  "amount_mismatch",
  "underpaid",
]);

/**
 * Store and reconcile one normalized transaction (design D4, steps 1–5).
 *
 * @param {object} db adapter
 * @param {{
 *   provider: object,            // a paymentProviders row (raw, with config parsed)
 *   tx: object,                  // normalized: externalId, direction, amount, currency, content, occurredAt, raw
 *   via: "webhook"|"poll",
 *   nowIso?: string,
 *   dryRun?: boolean,
 *   settings?: object,           // needs paymentCodePrefix; defaults to "DR"
 *   forceReason?: string|null,   // a reason the caller already established
 * }} params
 * @returns {{outcome: "duplicate"|"matched"|"needs_review"|"ignored",
 *            reason?: string, orderId?: string|null, transactionId?: string|null}}
 */
export function ingestTransactionSync(db, {
  provider,
  tx,
  via = "poll",
  nowIso = null,
  dryRun = false,
  settings = null,
  forceReason = null,
} = {}) {
  if (!db) throw new Error("ingestTransactionSync requires the db adapter");
  if (!provider || !provider.id) throw new Error("ingestTransactionSync requires a provider");
  if (!tx || !tx.externalId) return { outcome: "ignored", reason: "no_external_id" };

  // 1. Outgoing money is not an incoming payment: never stored.
  if (tx.direction !== "in") return { outcome: "ignored", reason: "outgoing" };

  const receivedAt = nowIso || new Date().toISOString();
  const prefix = String(settings?.paymentCodePrefix || "DR").toUpperCase();

  const existing = db.get(
    `SELECT id FROM paymentTransactions WHERE providerId = ? AND externalId = ?`,
    [provider.id, String(tx.externalId)]
  );
  // 2. Deduplication. In a dry run nothing is written, so a SELECT is the whole
  //    check; a real ingest leans on the UNIQUE index and treats the conflict as
  //    "already seen".
  if (existing) return { outcome: "duplicate", transactionId: existing.id };

  // 3–4. Decide what this transaction means, using the same rules a dry run
  //      reports, so "Chạy thử" cannot disagree with what a real poll would do.
  // A caller that already knows this money cannot belong to an order (the SePay
  // webhook sees the payload's `accountNumber`) short-circuits the match instead
  // of letting a coincidental code in the memo approve it.
  const decision = forceReason
    ? { outcome: "needs_review", reason: forceReason, orderId: null }
    : decideSync(db, { provider, tx, prefix, nowIso: receivedAt });

  if (dryRun) {
    return { ...decision, transactionId: null, dryRun: true };
  }

  const transactionId = uuidv4();
  try {
    db.run(
      `INSERT INTO paymentTransactions(
         id, providerId, kind, externalId, amount, currency, content, occurredAt,
         receivedAt, via, raw, status, reason, orderId
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        transactionId,
        provider.id,
        provider.kind,
        String(tx.externalId),
        Math.round(Number(tx.amount) || 0),
        tx.currency,
        tx.content == null ? null : String(tx.content),
        tx.occurredAt ?? null,
        receivedAt,
        via,
        safeJson(tx.raw),
        decision.outcome === "matched" ? "matched" : "needs_review",
        decision.reason ?? null,
        decision.orderId ?? null,
      ]
    );
  } catch (error) {
    // UNIQUE(providerId, externalId): another delivery won the race. Nothing else
    // was written, so this is a clean duplicate.
    if (/UNIQUE|constraint/i.test(error?.message || "")) {
      const row = db.get(
        `SELECT id FROM paymentTransactions WHERE providerId = ? AND externalId = ?`,
        [provider.id, String(tx.externalId)]
      );
      return { outcome: "duplicate", transactionId: row?.id ?? null };
    }
    throw error;
  }

  // 5. Approve. `approveOrderSync` re-checks the status inside this same write
  //    transaction, so a concurrent approval cannot grant twice; when it did win,
  //    the transaction row is downgraded to needs_review instead of claiming a
  //    match that did not happen.
  if (decision.outcome === "matched") {
    const approved = approveOrderSync(db, decision.orderId, {
      approvedBy: `payment:${provider.kind}`,
      now: receivedAt,
      paymentTransactionId: transactionId,
    });
    if (!approved || approved.alreadyApproved) {
      db.run(
        `UPDATE paymentTransactions SET status = 'needs_review', reason = 'order_not_pending' WHERE id = ?`,
        [transactionId]
      );
      return {
        outcome: "needs_review",
        reason: "order_not_pending",
        orderId: decision.orderId,
        transactionId,
      };
    }
    return { outcome: "matched", orderId: decision.orderId, transactionId };
  }

  return {
    outcome: "needs_review",
    reason: decision.reason,
    orderId: decision.orderId ?? null,
    transactionId,
  };
}

/**
 * The matching rules, with no side effects (design D4 steps 3–4).
 *
 * Extracted so the dry run, the real ingest and the tests all read the same code.
 *
 * @returns {{outcome: "matched"|"needs_review", reason?: string, orderId?: string|null}}
 */
export function decideSync(db, { provider, tx, prefix, nowIso = null }) {
  const candidates = extractCandidateCodes(tx.content ?? "", prefix);

  let orderRow = null;
  if (candidates.length === 0) {
    return { outcome: "needs_review", reason: "no_code", orderId: null };
  }
  for (const code of candidates) {
    const row = db.get(`SELECT * FROM orders WHERE paymentCode = ?`, [code]);
    if (row) {
      orderRow = row;
      break;
    }
  }
  if (!orderRow) {
    return { outcome: "needs_review", reason: "order_not_found", orderId: null };
  }

  const orderId = orderRow.id;

  // The order must name the account the money actually arrived at. Without this,
  // two receiving accounts in one company would both claim the same code.
  if (orderRow.paymentProviderId !== provider.id) {
    return { outcome: "needs_review", reason: "wrong_provider", orderId };
  }

  if (orderRow.status !== "pending") {
    // Paid, cancelled, refunded AND expired-beyond-revival all land here; the
    // expiry case is reported separately below so the admin sees the real cause.
    if (orderRow.status === "expired") {
      return { outcome: "needs_review", reason: "order_expired", orderId };
    }
    return { outcome: "needs_review", reason: "order_not_pending", orderId };
  }

  const occurred = tx.occurredAt ? Date.parse(tx.occurredAt) : null;
  const expiresAt = orderRow.expiresAt ? Date.parse(orderRow.expiresAt) : null;

  if (occurred != null && Number.isFinite(expiresAt) && occurred > expiresAt) {
    return { outcome: "needs_review", reason: "order_expired", orderId };
  }

  // A payment that predates the order by more than the clock-skew allowance cannot
  // belong to it. Codes are unique, so this only protects against a forged/misread
  // memo and against a provider replaying a much older transfer.
  const createdAt = orderRow.createdAt ? Date.parse(orderRow.createdAt) : null;
  if (occurred != null && Number.isFinite(createdAt) && occurred < createdAt - CLOCK_SKEW_MS) {
    return { outcome: "needs_review", reason: "order_not_found", orderId };
  }

  const expectedCurrency = orderRow.payCurrency ?? null;
  if (expectedCurrency && expectedCurrency !== tx.currency) {
    return { outcome: "needs_review", reason: "wrong_provider", orderId };
  }

  const payAmount = nano(orderRow.payAmount);
  if (!Number.isFinite(payAmount) || payAmount <= 0) {
    // A gateway order always carries its amount; a zero means the row is corrupt.
    return { outcome: "needs_review", reason: "amount_mismatch", orderId };
  }

  const received = Math.round(Number(tx.amount) || 0);
  if (tx.currency === "VND") {
    // Exact. A bank transfer cannot be "close enough": 249,999đ for a 250,000đ
    // order is a different amount, and crediting it would make the shortfall
    // somebody's invisible loss.
    if (received !== payAmount) return { outcome: "needs_review", reason: "amount_mismatch", orderId };
  } else if (received < payAmount) {
    // USDT: overpayment is accepted (rate drift is real and the customer meant to
    // pay), underpayment is not.
    return { outcome: "needs_review", reason: "underpaid", orderId };
  }

  return { outcome: "matched", orderId };
}

/**
 * Admin resolution of a needs_review transaction (design D4, spec
 * "Admin resolution of transactions").
 *
 * `assign` approves the order through the normal grant path — regardless of the
 * amount difference, because the admin has looked at the bank — and `resolve`
 * closes the row without crediting anything.
 *
 * @returns {{ok: true, transaction: object, order?: object}
 *          | {ok: false, error: string, code: "not_found"|"already"|"invalid"|"order_not_resolvable"}}
 */
export function resolveTransactionSync(db, {
  transactionId,
  action,
  orderId = null,
  reason,
  actor,
  nowIso = null,
} = {}) {
  if (!db) throw new Error("resolveTransactionSync requires the db adapter");

  const note = reason == null ? "" : String(reason).trim();
  if (note.length < 3 || note.length > 500) {
    return { ok: false, code: "invalid", error: "Lý do phải có từ 3 đến 500 ký tự" };
  }
  if (action !== "assign" && action !== "resolve") {
    return { ok: false, code: "invalid", error: "Thao tác không hợp lệ" };
  }
  if (!actor) return { ok: false, code: "invalid", error: "Thiếu người thực hiện" };

  const transaction = db.get(`SELECT * FROM paymentTransactions WHERE id = ?`, [transactionId]);
  if (!transaction) return { ok: false, code: "not_found", error: "Không tìm thấy giao dịch" };

  // Only a needs_review row may be resolved. A matched row already approved an
  // order; resolving it again is the double-credit path this check exists for.
  if (transaction.status !== "needs_review") {
    return { ok: false, code: "already", error: "Giao dịch này đã được xử lý" };
  }

  const at = nowIso || new Date().toISOString();

  if (action === "resolve") {
    db.run(
      `UPDATE paymentTransactions
          SET status = 'resolved', resolvedBy = ?, resolvedAt = ?, resolutionNote = ?
        WHERE id = ? AND status = 'needs_review'`,
      [actor, at, note, transactionId]
    );
    if (transaction.orderId) {
      const order = getOrderRowSync(db, transaction.orderId);
      if (order) {
        insertAuditSync(db, {
          userId: order.userId,
          actor,
          action: "payment_resolved",
          reason: note,
          details: {
            transactionId,
            orderId: order.id,
            amount: transaction.amount,
            currency: transaction.currency,
            externalId: transaction.externalId,
          },
          now: at,
        });
      }
    }
    return { ok: true, transaction: readTransaction(db, transactionId) };
  }

  // assign
  if (!orderId) return { ok: false, code: "invalid", error: "Cần chọn đơn để gán" };
  const order = getOrderRowSync(db, orderId);
  if (!order) return { ok: false, code: "invalid", error: "Không tìm thấy đơn" };
  if (order.status !== "pending" && order.status !== "expired") {
    return { ok: false, code: "order_not_resolvable", error: "Chỉ gán được vào đơn đang chờ hoặc đã hết hạn" };
  }

  const approved = approveOrderSync(db, orderId, {
    approvedBy: actor,
    now: at,
    paymentTransactionId: transactionId,
    // A late payment is exactly the case this action exists for.
    allowExpired: true,
  });
  if (!approved || approved.alreadyApproved) {
    return { ok: false, code: "order_not_resolvable", error: "Đơn này đã được thanh toán" };
  }

  db.run(
    `UPDATE paymentTransactions
        SET status = 'matched', orderId = ?, reason = 'admin_assigned',
            resolvedBy = ?, resolvedAt = ?, resolutionNote = ?
      WHERE id = ? AND status = 'needs_review'`,
    [orderId, actor, at, note, transactionId]
  );

  insertAuditSync(db, {
    userId: order.userId,
    actor,
    action: "payment_assigned",
    reason: note,
    details: {
      transactionId,
      orderId,
      externalId: transaction.externalId,
      amount: transaction.amount,
      currency: transaction.currency,
      previousReason: transaction.reason ?? null,
      // The reason the payment was not automatic, kept so the audit explains why
      // an admin had to intervene even after the resolution note is read.
      orderStatusBefore: order.status,
    },
    now: at,
  });

  return {
    ok: true,
    transaction: readTransaction(db, transactionId),
    order: { ...approved.order },
  };
}

/** One transaction row in the shape the admin API returns (raw decoded). */
export function readTransaction(db, id) {
  const row = db.get(`SELECT * FROM paymentTransactions WHERE id = ?`, [id]);
  return rowToTransaction(row);
}

export function rowToTransaction(row) {
  if (!row) return null;
  return {
    id: row.id,
    providerId: row.providerId,
    kind: row.kind,
    externalId: row.externalId,
    amount: Number(row.amount) || 0,
    currency: row.currency,
    content: row.content ?? null,
    occurredAt: row.occurredAt ?? null,
    receivedAt: row.receivedAt ?? null,
    via: row.via ?? null,
    raw: parseJson(row.raw, null),
    status: row.status,
    reason: row.reason ?? null,
    orderId: row.orderId ?? null,
    resolvedBy: row.resolvedBy ?? null,
    resolvedAt: row.resolvedAt ?? null,
    resolutionNote: row.resolutionNote ?? null,
  };
}

/** Exposed so the API/tests can validate a reason with the same rule. */
export function isValidReason(reason) {
  const text = reason == null ? "" : String(reason).trim();
  return text.length >= 3 && text.length <= 500;
}

/** Exported for the dry-run result table so the UI and rules cannot drift. */
export const REVIEW_REASONS = Array.from(REASONS);

function safeJson(value) {
  try {
    return stringifyJson(value ?? null);
  } catch {
    return null;
  }
}
