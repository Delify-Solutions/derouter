// Admin users list: filters, sorting, pagination and aggregates in ONE query set.
//
// Spec admin-user-management "Users list". The shape that matters operationally is
// "give me the 50 customers I need to look at": search, group, status, whether they
// hold a plan, whether they are in debt, sorted by spend. Every figure is computed
// with a set-based aggregate joined onto the page's ids, never one query per row —
// 5 000 customers must not become 15 000 queries.
import { getAdapter } from "../driver.js";
import { nano } from "../../billing/ledger.js";

// Column names in the OUTER select (the CTEs already flattened the `u.` prefix), so
// sorting refers to the derived names the query actually exposes.
const SORTABLE = {
  createdAt: "createdAt",
  lastLoginAt: "lastLoginAt",
  available: "availableNanoUsd",
  spend30d: "spend30dNanoUsd",
};

const PLAN_STATES = new Set(["active", "none", "debt"]);

function nowIso() {
  return new Date().toISOString();
}

/**
 * @param {object} query
 * @param {string} [query.q]            substring of email or display name
 * @param {string} [query.groupId]
 * @param {string} [query.status]
 * @param {string} [query.planState]    active | none | debt
 * @param {string} [query.sort]         createdAt | lastLoginAt | available | spend30d
 * @param {string} [query.dir]          asc | desc
 * @param {number} [query.page]         from 1
 * @param {number} [query.pageSize]     default 50, max 100
 */
export async function listUsersAdmin(query = {}) {
  const db = await getAdapter();
  const at = nowIso();

  const take = Math.min(Math.max(1, Math.floor(Number(query.pageSize) || 50)), 100);
  const page = Math.max(1, Math.floor(Number(query.page) || 1));
  const skip = (page - 1) * take;

  // These predicates are applied to the OUTER query over the `d` CTE, whose columns
  // are unqualified (the CTE already flattened them off `u.`). Qualifying them as
  // `u.email` / `u.groupId` / `u.status` is a "no such column" error — which is what
  // made every search and filter 500.
  const where = [];
  const params = [];

  const q = typeof query.q === "string" ? query.q.trim() : "";
  if (q) {
    where.push(`(LOWER(email) LIKE ? OR LOWER(COALESCE(displayName, '')) LIKE ?)`);
    const like = `%${q.toLowerCase()}%`;
    params.push(like, like);
  }
  if (query.groupId) {
    where.push(`groupId = ?`);
    params.push(String(query.groupId));
  }
  if (query.status) {
    where.push(`status = ?`);
    params.push(String(query.status));
  }

  const spendSince = new Date(Date.now() - 30 * 86_400_000).toISOString();

  // Per-user aggregates as correlated sub-selects in a CTE. SQLite evaluates these
  // once per candidate row; the planState filter has to see them, so they cannot be
  // joined only after LIMIT.
  const base = `
    WITH agg AS (
      SELECT
        u.id,
        u.email,
        u.displayName,
        u.groupId,
        u.status,
        u.createdAt,
        u.lastLoginAt,
        u.overdraftNanoUsd,
        g.name AS groupName,
        COALESCE((SELECT SUM(up.creditRemainingNanoUsd) FROM userPlans up
                   WHERE up.userId = u.id AND up.status = 'active' AND up.expiresAt > ?), 0) AS liveCredit,
        COALESCE(u.overdraftNanoUsd, 0) AS debt,
        (SELECT COUNT(*) FROM userPlans up
          WHERE up.userId = u.id AND up.status = 'active' AND up.expiresAt > ?) AS queuedPlans,
        EXISTS(SELECT 1 FROM userPlans up
                WHERE up.userId = u.id AND up.status = 'active' AND up.unlimitedCredit = 1
                  AND up.expiresAt > ?) AS hasUnlimited,
        COALESCE((SELECT SUM(uh.costNanoUsd) FROM usageHistory uh
                   WHERE uh.timestamp >= ?
                     AND uh.apiKeyId IN (SELECT k.id FROM apiKeys k WHERE k.userId = u.id)), 0) AS spend30d,
        (SELECT MAX(uh.timestamp) FROM usageHistory uh
          WHERE uh.apiKeyId IN (SELECT k.id FROM apiKeys k WHERE k.userId = u.id)) AS lastUsageAt
      FROM users u
      LEFT JOIN keyGroups g ON g.id = u.groupId
    )`;

  // Derived columns are computed once in a second CTE so both the WHERE (planState)
  // and the ORDER BY can refer to them by name.
  const derived = `
    , d AS (
      SELECT *,
        MAX(0, liveCredit - debt) AS availableNanoUsd,
        spend30d AS spend30dNanoUsd
      FROM agg
    )`;

  const outerWhere = [...where];
  const outerParams = [...params];
  if (PLAN_STATES.has(query.planState)) {
    if (query.planState === "active") outerWhere.push(`queuedPlans > 0`);
    else if (query.planState === "none") outerWhere.push(`queuedPlans = 0`);
    else if (query.planState === "debt") outerWhere.push(`debt > 0`);
  }
  const clause = outerWhere.length ? `WHERE ${outerWhere.join(" AND ")}` : "";

  const sortColumn = SORTABLE[query.sort] ?? SORTABLE.createdAt;
  const dir = String(query.dir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";

  // The CTE parameters are bound in textual order: the four `?` in `agg`, then the
  // filter parameters, then LIMIT/OFFSET.
  const cteParams = [at, at, at, spendSince];

  const rows = db.all(
    `${base}${derived}
     SELECT id, email, displayName, groupId, groupName, status, createdAt, lastLoginAt,
            availableNanoUsd, debt, spend30dNanoUsd, queuedPlans, hasUnlimited, lastUsageAt, overdraftNanoUsd
       FROM d
       ${clause}
      ORDER BY ${sortColumn} ${dir}, id ASC
      LIMIT ? OFFSET ?`,
    [...cteParams, ...outerParams, take, skip]
  );

  const total = Number(
    db.get(`${base}${derived} SELECT COUNT(*) AS c FROM d ${clause}`, [...cteParams, ...outerParams])?.c ?? 0
  );

  return {
    users: rows.map((row) => ({
      id: row.id,
      email: row.email,
      displayName: row.displayName ?? null,
      groupId: row.groupId ?? null,
      groupName: row.groupName ?? null,
      status: row.status,
      createdAt: row.createdAt ?? null,
      lastLoginAt: row.lastLoginAt ?? null,
      queuedPlans: nano(row.queuedPlans),
      availableNanoUsd: nano(row.availableNanoUsd),
      // A live unlimited plan adds nothing to availableNanoUsd, so the list needs
      // the flag to avoid showing such a customer as having no credit.
      hasUnlimitedCredit: Number(row.hasUnlimited) === 1,
      debtNanoUsd: nano(row.debt),
      spend30dNanoUsd: nano(row.spend30dNanoUsd),
      lastUsageAt: row.lastUsageAt ?? null,
    })),
    total,
    page,
    pageSize: take,
  };
}

/**
 * Everything the user detail page shows in its `summary` (design D18):
 * available credit, debt, spend over 7 and 30 days, key count, open sessions.
 */
export async function getUserSummary(userId) {
  const db = await getAdapter();
  const at = nowIso();
  const since7 = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();

  const creditRow = db.get(
    `SELECT
       COALESCE((SELECT SUM(creditRemainingNanoUsd) FROM userPlans
                  WHERE userId = ? AND status = 'active' AND expiresAt > ?), 0) AS credit,
       EXISTS(SELECT 1 FROM userPlans WHERE userId = ? AND status = 'active'
                AND unlimitedCredit = 1 AND expiresAt > ?) AS hasUnlimited,
       COALESCE((SELECT overdraftNanoUsd FROM users WHERE id = ?), 0) AS debt`,
    [userId, at, userId, at, userId]
  );

  const spend = (since) =>
    nano(
      db.get(
        `SELECT COALESCE(SUM(uh.costNanoUsd), 0) AS total
           FROM usageHistory uh
          WHERE uh.timestamp >= ?
            AND uh.apiKeyId IN (SELECT k.id FROM apiKeys k WHERE k.userId = ?)`,
        [since, userId]
      )?.total
    );

  return {
    availableNanoUsd: Math.max(0, nano(creditRow?.credit) - nano(creditRow?.debt)),
    hasUnlimitedCredit: Number(creditRow?.hasUnlimited) === 1,
    debtNanoUsd: nano(creditRow?.debt),
    spend7dNanoUsd: spend(since7),
    spend30dNanoUsd: spend(since30),
    keyCount: Number(db.get(`SELECT COUNT(*) AS n FROM apiKeys WHERE userId = ?`, [userId])?.n ?? 0),
    sessionCount: Number(
      db.get(
        `SELECT COUNT(*) AS n FROM userSessions WHERE userId = ? AND revokedAt IS NULL AND expiresAt > ?`,
        [userId, at]
      )?.n ?? 0
    ),
  };
}

/**
 * Usage for the admin Usage tab (design D18): cost per day and per model over the
 * last 7 or 30 days, across all of the user's keys.
 */
export async function getUserUsage(userId, { range = "7d" } = {}) {
  const db = await getAdapter();
  const days = range === "30d" ? 30 : 7;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const keyScope = `uh.apiKeyId IN (SELECT k.id FROM apiKeys k WHERE k.userId = ?)`;

  const dailyRows = db.all(
    `SELECT substr(uh.timestamp, 1, 10) AS date,
            COUNT(*) AS requests,
            COALESCE(SUM(uh.costNanoUsd), 0) AS costNanoUsd
       FROM usageHistory uh
      WHERE uh.timestamp >= ? AND ${keyScope}
      GROUP BY date
      ORDER BY date ASC`,
    [since, userId]
  );

  const modelRows = db.all(
    `SELECT uh.model AS model,
            COUNT(*) AS requests,
            COALESCE(SUM(uh.promptTokens), 0) AS promptTokens,
            COALESCE(SUM(uh.completionTokens), 0) AS completionTokens,
            COALESCE(SUM(uh.costNanoUsd), 0) AS costNanoUsd
       FROM usageHistory uh
      WHERE uh.timestamp >= ? AND ${keyScope}
      GROUP BY uh.model
      ORDER BY costNanoUsd DESC`,
    [since, userId]
  );

  return {
    range: days === 30 ? "30d" : "7d",
    daily: dailyRows.map((row) => ({
      date: row.date,
      requests: nano(row.requests),
      costNanoUsd: nano(row.costNanoUsd),
    })),
    byModel: modelRows.map((row) => ({
      model: row.model ?? "—",
      requests: nano(row.requests),
      promptTokens: nano(row.promptTokens),
      completionTokens: nano(row.completionTokens),
      costNanoUsd: nano(row.costNanoUsd),
    })),
  };
}
