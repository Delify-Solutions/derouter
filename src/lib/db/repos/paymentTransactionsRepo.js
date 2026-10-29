// Stored payment transactions: the admin's read model (design D8, spec
// "Transactions list").
//
// Writes belong to the reconciliation engine (`src/lib/payments/reconcile.js`),
// which needs the raw adapter and no driver import. This repo only reads — with
// filters, pagination at 50 per page, the linked order's customer email and the
// needs-review count the sidebar badge uses.
import { getAdapter } from "../driver.js";
import { parseJson } from "../helpers/jsonCol.js";
import { rowToTransaction } from "../../payments/reconcile.js";

export const TRANSACTION_STATUSES = ["matched", "needs_review", "resolved"];
export const PAGE_SIZE = 50;

const LIST_SELECT = `
  SELECT t.*, o.payCurrency AS orderPayCurrency, o.payAmount AS orderPayAmount,
         COALESCE(u.email, o.emailSnapshot) AS orderUserEmail,
         p.name AS orderPlanName, p.code AS orderPlanCode
    FROM paymentTransactions t
    LEFT JOIN orders o ON o.id = t.orderId
    LEFT JOIN users u ON u.id = o.userId
    LEFT JOIN plans p ON p.id = o.planId`;

/**
 * One page of transactions, newest first.
 *
 * @param {{ status?: string|null, providerId?: string|null, from?: string|null,
 *           to?: string|null, page?: number, pageSize?: number }} filters
 */
export async function listTransactions({
  status = null,
  providerId = null,
  from = null,
  to = null,
  page = 1,
  pageSize = PAGE_SIZE,
} = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];

  if (status) {
    where.push(`t.status = ?`);
    params.push(status);
  }
  if (providerId) {
    where.push(`t.providerId = ?`);
    params.push(providerId);
  }
  // Date range on the occurrence time when the provider gave one, else on receipt:
  // an admin filtering "yesterday" means the bank's clock, not our ingest clock.
  if (from) {
    where.push(`COALESCE(t.occurredAt, t.receivedAt) >= ?`);
    params.push(from);
  }
  if (to) {
    where.push(`COALESCE(t.occurredAt, t.receivedAt) <= ?`);
    params.push(to);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const take = Math.min(Math.max(1, Math.floor(Number(pageSize) || PAGE_SIZE)), 200);
  const pageNumber = Math.max(1, Math.floor(Number(page) || 1));
  const skip = (pageNumber - 1) * take;

  const rows = db.all(
    `${LIST_SELECT} ${clause} ORDER BY t.receivedAt DESC, t.id DESC LIMIT ? OFFSET ?`,
    [...params, take, skip]
  );
  const countRow = db.get(`SELECT COUNT(*) AS c FROM paymentTransactions t ${clause}`, params);

  return {
    transactions: rows.map(decorate),
    total: Number(countRow?.c ?? 0),
    page: pageNumber,
    pageSize: take,
  };
}

function decorate(row) {
  const base = rowToTransaction(row);
  return {
    ...base,
    order: row.orderId
      ? {
          id: row.orderId,
          userEmail: row.orderUserEmail ?? null,
          planName: row.orderPlanName ?? null,
          planCode: row.orderPlanCode ?? null,
          payCurrency: row.orderPayCurrency ?? null,
          payAmount: row.orderPayAmount == null ? null : Number(row.orderPayAmount),
        }
      : null,
    // `raw` is the provider payload; the list keeps it so the drawer needs no
    // second request, which is why it is decoded here rather than left as text.
    raw: parseJson(row.raw, null),
  };
}

/** How many transactions are waiting for an admin decision (sidebar badge). */
export async function countNeedsReview() {
  const db = await getAdapter();
  const row = db.get(`SELECT COUNT(*) AS c FROM paymentTransactions WHERE status = 'needs_review'`);
  return Number(row?.c ?? 0);
}

/** One transaction with its linked order, or null. */
export async function getTransaction(id) {
  if (!id) return null;
  const db = await getAdapter();
  const row = db.get(`${LIST_SELECT} WHERE t.id = ?`, [id]);
  return row ? decorate(row) : null;
}

/** The provider rows a filter dropdown needs: id, kind, name only. */
export async function listProviderOptions() {
  const db = await getAdapter();
  return db.all(
    `SELECT id, kind, name FROM paymentProviders ORDER BY COALESCE(sortOrder, 0) ASC, createdAt ASC`
  );
}
