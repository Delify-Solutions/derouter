// Account history for the customer's "Tài khoản → Lịch sử" tab (change
// account-settings, design D2). Read from existing tables, merged here; no event
// table. Every query is scoped to ONE userId taken from the session.
//
// Synchronous, adapter first, relative imports only (tests import it directly).

/** Activity-log actions shown as security events, in no particular order. */
export const SECURITY_ACTIONS = [
  "register",
  "login",
  "logout",
  "login_failed",
  "login_blocked",
  "password_change",
  "password_reset",
  "email_verified",
  "email_change_requested",
  "email_changed",
  "telegram_link",
  "telegram_unlink",
  "key_create",
  "key_delete",
];

export const HISTORY_GROUPS = ["all", "security", "orders", "plans"];
export const HISTORY_MAX_OFFSET = 2000;
export const HISTORY_MAX_LIMIT = 50;

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The code as the customer typed it: a deleted code may carry a `~deleted~<id>` suffix. */
function visibleGiftCode(code) {
  if (!code) return null;
  return String(code).split("~")[0] || null;
}

function securityEntries(db, userId, take) {
  const marks = SECURITY_ACTIONS.map(() => "?").join(", ");
  return db.all(
    `SELECT id, action, ip, userAgent, details, createdAt FROM activityLog
      WHERE userId = ? AND action IN (${marks})
      ORDER BY createdAt DESC, id DESC LIMIT ?`,
    [userId, ...SECURITY_ACTIONS, take]
  ).map((row) => ({
    group: "security",
    type: row.action,
    at: row.createdAt,
    id: `a:${row.id}`,
    ip: row.ip ?? null,
    userAgent: row.userAgent ?? null,
    details: parseJson(row.details),
  }));
}

function orderEntries(db, userId, take) {
  return db.all(
    `SELECT o.id, o.status, o.method, o.payCurrency, o.payAmount, o.amountNanoUsd, o.periods,
            o.createdAt, o.paidAt, p.name AS planName, p.code AS planCode
       FROM orders o LEFT JOIN plans p ON p.id = o.planId
      WHERE o.userId = ?
      ORDER BY o.createdAt DESC, o.rowid DESC LIMIT ?`,
    [userId, take]
  ).map((row) => ({
    group: "orders",
    type: "order",
    at: row.createdAt,
    id: `o:${row.id}`,
    orderId: row.id,
    status: row.status,
    method: row.method ?? null,
    planName: row.planName || row.planCode || null,
    payCurrency: row.payCurrency || "USD",
    // đồng for VND, nano-USDT for USDT, nano-USD otherwise (orders schema).
    payAmount: row.payAmount == null ? Number(row.amountNanoUsd ?? 0) : Number(row.payAmount),
    periods: row.periods == null ? 1 : Number(row.periods),
    paidAt: row.paidAt ?? null,
  }));
}

function planEntries(db, userId, take, nowIso) {
  const rows = db.all(
    `SELECT up.id, up.source, up.status, up.creditTotalNanoUsd, up.unlimitedCredit, up.startsAt,
            up.expiresAt, up.createdAt, p.name AS planName, p.code AS planCode, g.code AS giftCode
       FROM userPlans up
       LEFT JOIN plans p ON p.id = up.planId
       LEFT JOIN giftRedemptions r ON r.userPlanId = up.id
       LEFT JOIN giftCodes g ON g.id = r.giftId
      WHERE up.userId = ?
      ORDER BY up.createdAt DESC, up.rowid DESC LIMIT ?`,
    [userId, take]
  );
  const expired = db.all(
    `SELECT up.id, up.source, up.expiresAt, p.name AS planName, p.code AS planCode
       FROM userPlans up LEFT JOIN plans p ON p.id = up.planId
      WHERE up.userId = ? AND up.expiresAt <= ? AND up.status NOT IN ('revoked', 'refunded')
      ORDER BY up.expiresAt DESC, up.rowid DESC LIMIT ?`,
    [userId, nowIso, take]
  );
  return [
    ranked(rows.map((row) => ({
      group: "plans",
      type: "plan_granted",
      at: row.createdAt || row.startsAt,
      id: `g:${row.id}`,
      userPlanId: row.id,
      source: row.source,
      planName: row.planName || row.planCode || null,
      creditNanoUsd: Number(row.creditTotalNanoUsd ?? 0),
      unlimitedCredit: Number(row.unlimitedCredit) === 1,
      expiresAt: row.expiresAt ?? null,
      giftCode: visibleGiftCode(row.giftCode),
      revoked: row.status === "revoked",
    })), 2),
    ranked(expired.map((row) => ({
      group: "plans",
      type: "plan_expired",
      at: row.expiresAt,
      id: `e:${row.id}`,
      userPlanId: row.id,
      source: row.source,
      planName: row.planName || row.planCode || null,
    })), 3),
  ];
}

// One total order shared by every page: time, then the source, then the row's
// rank in that source's own SQL order (which is total: time plus id/rowid). A
// page is then always a prefix of the same merged list, so offset paging has no
// duplicates or gaps even when timestamps tie (a multi-period grant writes
// several rows with one createdAt).
function newestFirst(a, b) {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  if (a._source !== b._source) return a._source - b._source;
  return a._rank - b._rank;
}

function ranked(list, source) {
  return list.map((entry, index) => ({ ...entry, _source: source, _rank: index }));
}

/**
 * One page of the merged timeline, newest first.
 *
 * Each source is read with `LIMIT offset + limit + 1` and the lists are merged
 * by time, so a page is exact for any offset up to HISTORY_MAX_OFFSET.
 *
 * @returns {{ entries: object[], hasMore: boolean, offset: number, limit: number }}
 */
export function listAccountHistorySync(db, userId, { group = "all", offset = 0, limit = 30, now = Date.now() } = {}) {
  if (!db) throw new Error("listAccountHistorySync requires the db adapter");
  if (!userId) return { entries: [], hasMore: false, offset: 0, limit: 0 };
  const g = HISTORY_GROUPS.includes(group) ? group : "all";
  const skip = Math.min(HISTORY_MAX_OFFSET, Math.max(0, Math.floor(Number(offset) || 0)));
  const take = Math.min(HISTORY_MAX_LIMIT, Math.max(1, Math.floor(Number(limit) || 30)));
  const need = skip + take + 1;
  const nowIso = new Date(now).toISOString();

  const merged = [];
  if (g === "all" || g === "security") merged.push(...ranked(securityEntries(db, userId, need), 0));
  if (g === "all" || g === "orders") merged.push(...ranked(orderEntries(db, userId, need), 1));
  if (g === "all" || g === "plans") {
    const [grants, expiries] = planEntries(db, userId, need, nowIso);
    merged.push(...grants, ...expiries);
  }
  merged.sort(newestFirst);

  return {
    entries: merged.slice(skip, skip + take).map(({ _source, _rank, ...entry }) => entry),
    hasMore: merged.length > skip + take && skip + take < HISTORY_MAX_OFFSET,
    offset: skip,
    limit: take,
  };
}

/**
 * Summary figures for the top of the tab: creation, last sign-in, paid orders and
 * the total paid per currency, credit spent and requests charged.
 */
export function accountSummarySync(db, userId) {
  if (!db) throw new Error("accountSummarySync requires the db adapter");
  const user = db.get(`SELECT createdAt, lastLoginAt FROM users WHERE id = ?`, [userId]);
  if (!user) return null;
  const paid = db.all(
    `SELECT COALESCE(payCurrency, 'USD') AS currency, COUNT(*) AS n,
            COALESCE(SUM(COALESCE(payAmount, amountNanoUsd, 0)), 0) AS total
       FROM orders WHERE userId = ? AND status = 'paid'
      GROUP BY COALESCE(payCurrency, 'USD')`,
    [userId]
  );
  const charges = db.get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(-deltaNanoUsd), 0) AS spent
       FROM creditLedger WHERE userId = ? AND kind = 'charge'`,
    [userId]
  );
  const totals = {};
  let paidOrders = 0;
  for (const row of paid) {
    totals[row.currency] = Number(row.total) || 0;
    paidOrders += Number(row.n) || 0;
  }
  return {
    createdAt: user.createdAt ?? null,
    lastLoginAt: user.lastLoginAt ?? null,
    paidOrders,
    paidTotals: totals,
    creditSpentNanoUsd: Number(charges?.spent) || 0,
    requestsCharged: Number(charges?.n) || 0,
  };
}
