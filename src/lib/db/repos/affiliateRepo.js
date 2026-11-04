// Affiliate program data access: the async face of the synchronous affiliate core.
//
// Every function here resolves the adapter and opens ONE `db.transaction` around
// the sync functions from src/lib/affiliate/* (design D2/D3/D5). Routes never call
// the sync modules directly, so the "release due commissions, then read the
// balance" ordering and the withdrawal checks happen in the same write.
//
// Money is integer: đồng for VND, nano-USD for USD.
import { getAdapter } from "../driver.js";
import { insertAuditSync } from "../../billing/audit.js";
import {
  ensureAffiliateSync,
  getAffiliateSync,
  effectiveTermsSync,
  resolveFirstReferralSync,
  hasWalletHistorySync,
} from "../../affiliate/core.js";
import { readAffiliateSettingsSync } from "../../affiliate/settings.js";
import {
  accrueCommissionSync,
  releaseAllDueSync,
  releaseDueSync,
} from "../../affiliate/commission.js";
import {
  walletSync,
  walletsSync,
  payoutDetailsSync,
  savePayoutSync,
  requestWithdrawalSync,
  decideWithdrawalSync,
  adjustWalletSync,
} from "../../affiliate/wallet.js";

function nowIso() {
  return new Date().toISOString();
}

/** Program settings as the customer page needs them (never the secrets). */
export async function getAffiliateSettings() {
  const db = await getAdapter();
  return readAffiliateSettingsSync(db);
}

/** Whether this account has wallet history and must keep seeing the page. */
export async function hasAffiliateHistory(userId) {
  const db = await getAdapter();
  return hasWalletHistorySync(db, userId);
}

/**
 * The first valid referral of `candidates` for registration (see
 * resolveFirstReferralSync). Async because the route is; the lookup itself must
 * not create anything.
 */
export async function resolveFirstReferral(candidates) {
  const db = await getAdapter();
  return resolveFirstReferralSync(db, candidates);
}

/**
 * The customer affiliate page payload (design D8): terms, wallet, payout details,
 * counters. `link` is composed by the caller, which knows the public origin.
 */
export async function getAffiliateOverview(userId) {
  const db = await getAdapter();
  return db.transaction(() => {
    const settings = readAffiliateSettingsSync(db);
    const enabled = settings.affiliateEnabled === true;
    const row = enabled ? ensureAffiliateSync(db, userId) : getAffiliateSync(db, userId);
    const terms = row ? effectiveTermsSync(row, settings) : null;
    const wallet = walletSync(db, userId);

    const signups = Number(
      db.get(`SELECT COUNT(*) AS n FROM users WHERE referredByUserId = ?`, [userId])?.n ?? 0
    );
    const payingReferrals = Number(
      db.get(
        `SELECT COUNT(DISTINCT referredUserId) AS n FROM affiliateCommissions
          WHERE affiliateUserId = ? AND status != 'reversed'`,
        [userId]
      )?.n ?? 0
    );

    return {
      enabled,
      code: row?.code ?? null,
      status: row?.status ?? null,
      rateBp: terms?.rateBp ?? null,
      maxOrders: terms?.maxOrders ?? null,
      giftCodeId: terms?.giftCodeId ?? null,
      clicks: row?.clickCount ?? 0,
      signups,
      payingReferrals,
      wallet,
      payout: payoutDetailsSync(db, userId),
      minWithdraw: {
        VND: Number(settings.affiliateMinWithdrawVnd ?? 0),
        USD: Number(settings.affiliateMinWithdrawUsdNano ?? 0),
      },
    };
  });
}

/** Save payout details for one currency. */
export async function setAffiliatePayout(userId, currency, details) {
  const db = await getAdapter();
  return db.transaction(() => savePayoutSync(db, userId, currency, details));
}

export async function requestWithdrawal(userId, { currency, amount }) {
  const db = await getAdapter();
  return db.transaction(() => requestWithdrawalSync(db, userId, { currency, amount }));
}

/** The affiliate's own withdrawals, newest first. */
export async function listMyWithdrawals(userId, { limit = 20, offset = 0 } = {}) {
  const db = await getAdapter();
  const take = Math.min(Math.max(1, Math.floor(Number(limit) || 20)), 100);
  const skip = Math.max(0, Math.floor(Number(offset) || 0));
  const rows = db.all(
    `SELECT * FROM affiliateWithdrawals WHERE userId = ? ORDER BY createdAt DESC, rowid DESC LIMIT ? OFFSET ?`,
    [userId, take, skip]
  );
  const total = Number(
    db.get(`SELECT COUNT(*) AS n FROM affiliateWithdrawals WHERE userId = ?`, [userId])?.n ?? 0
  );
  return { rows, total };
}

/** The affiliate's commissions, newest first. */
export async function listMyCommissions(userId, { limit = 20, offset = 0 } = {}) {
  const db = await getAdapter();
  const take = Math.min(Math.max(1, Math.floor(Number(limit) || 20)), 100);
  const skip = Math.max(0, Math.floor(Number(offset) || 0));
  const rows = db.all(
    `SELECT c.*, u.email AS buyerEmail
       FROM affiliateCommissions c
       LEFT JOIN users u ON u.id = c.referredUserId
      WHERE c.affiliateUserId = ?
      ORDER BY c.createdAt DESC, c.rowid DESC LIMIT ? OFFSET ?`,
    [userId, take, skip]
  );
  const total = Number(
    db.get(`SELECT COUNT(*) AS n FROM affiliateCommissions WHERE affiliateUserId = ?`, [userId])?.n ?? 0
  );
  return { rows, total };
}

/** The affiliate's referrals (accounts it brought in), newest first, with earnings. */
export async function listMyReferrals(userId, { limit = 20, offset = 0 } = {}) {
  const db = await getAdapter();
  const take = Math.min(Math.max(1, Math.floor(Number(limit) || 20)), 100);
  const skip = Math.max(0, Math.floor(Number(offset) || 0));
  const rows = db.all(
    `SELECT u.id, u.email, u.createdAt AS signedUpAt,
            COALESCE(SUM(CASE WHEN c.status != 'reversed' AND c.currency = 'VND' THEN c.amount ELSE 0 END), 0) AS earnedVnd,
            COALESCE(SUM(CASE WHEN c.status != 'reversed' AND c.currency = 'USD' THEN c.amount ELSE 0 END), 0) AS earnedUsdNano
       FROM users u
       LEFT JOIN affiliateCommissions c ON c.referredUserId = u.id AND c.affiliateUserId = ?
      WHERE u.referredByUserId = ?
      GROUP BY u.id
      ORDER BY u.createdAt DESC, u.rowid DESC LIMIT ? OFFSET ?`,
    [userId, userId, take, skip]
  );
  const total = Number(
    db.get(`SELECT COUNT(*) AS n FROM users WHERE referredByUserId = ?`, [userId])?.n ?? 0
  );
  return { rows, total };
}

// ── Admin ────────────────────────────────────────────────────────────────

/**
 * Admin affiliate list with aggregates (task 3.1): code, overrides, clicks,
 * signups, paying referrals, earned and balance per currency.
 *
 * All figures come from set-based queries over the page's ids — a list of 50 must
 * not become 200 queries.
 */
export async function listAffiliates({ q = "", status = "", limit = 50, offset = 0 } = {}) {
  const db = await getAdapter();
  const take = Math.min(Math.max(1, Math.floor(Number(limit) || 50)), 100);
  const skip = Math.max(0, Math.floor(Number(offset) || 0));

  const where = [];
  const params = [];
  const term = typeof q === "string" ? q.trim() : "";
  if (term) {
    const like = `%${term.toLowerCase()}%`;
    where.push(`(LOWER(u.email) LIKE ? OR LOWER(COALESCE(u.displayName, '')) LIKE ? OR LOWER(a.code) LIKE ?)`);
    params.push(like, like, like);
  }
  if (status === "active" || status === "blocked") {
    where.push(`a.status = ?`);
    params.push(status);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = Number(
    db.get(
      `SELECT COUNT(*) AS n FROM affiliates a JOIN users u ON u.id = a.userId ${whereSql}`,
      params
    )?.n ?? 0
  );

  const rows = db.all(
    `SELECT a.*, u.email, u.displayName,
            (SELECT COUNT(*) FROM users r WHERE r.referredByUserId = a.userId) AS signupCount,
            (SELECT COUNT(DISTINCT c.referredUserId) FROM affiliateCommissions c
              WHERE c.affiliateUserId = a.userId AND c.status != 'reversed') AS payingCount,
            (SELECT COALESCE(SUM(c.amount), 0) FROM affiliateCommissions c
              WHERE c.affiliateUserId = a.userId AND c.status != 'reversed' AND c.currency = 'VND') AS earnedVnd,
            (SELECT COALESCE(SUM(c.amount), 0) FROM affiliateCommissions c
              WHERE c.affiliateUserId = a.userId AND c.status != 'reversed' AND c.currency = 'USD') AS earnedUsdNano
       FROM affiliates a
       JOIN users u ON u.id = a.userId
       ${whereSql}
      ORDER BY a.createdAt DESC, a.rowid DESC LIMIT ? OFFSET ?`,
    [...params, take, skip]
  );

  const settings = readAffiliateSettingsSync(db);
  const ids = rows.map((row) => row.userId);

  // Wallet figures: one release pass for the whole page, then fixed queries.
  const wallets = db.transaction(() => walletsSync(db, ids));

  // "Same IP" hint (proposal "Blocking"/Risks): does any account this affiliate
  // referred share an IP with the affiliate itself? Both sides are read by userId
  // (idx_al_user_ts) and matched through the affiliate's own IP set. A self-join
  // on `ip` instead went quadratic when many rows share an IP (CGNAT, a proxy
  // address): 2.3 s per page load with 6 distinct IPs over 41k rows.
  const sharedIp = new Map();
  if (ids.length) {
    const placeholders = ids.map(() => "?").join(", ");
    const hits = db.all(
      `SELECT DISTINCT aff.userId AS affiliateUserId
         FROM affiliates aff
         JOIN users r ON r.referredByUserId = aff.userId
        WHERE aff.userId IN (${placeholders})
          AND EXISTS (
            SELECT 1
              FROM activityLog them
             WHERE them.userId = r.id
               AND them.ip IN (
                 SELECT me.ip FROM activityLog me
                  WHERE me.userId = aff.userId AND me.ip IS NOT NULL
               )
          )`,
      ids
    );
    for (const hit of hits) sharedIp.set(hit.affiliateUserId, true);
  }

  return {
    total,
    rows: rows.map((row) => ({
      ...row,
      rateBp: row.rateBp == null ? null : Number(row.rateBp),
      maxOrders: row.maxOrders == null ? null : Number(row.maxOrders),
      effective: effectiveTermsSync(row, settings),
      wallet: wallets.get(row.userId) ?? null,
      sharedIp: sharedIp.has(row.userId),
    })),
  };
}

/** One affiliate with everything the admin detail needs. */
export async function getAffiliateDetail(userId) {
  const db = await getAdapter();
  return db.transaction(() => {
    const row = getAffiliateSync(db, userId);
    if (!row) return null;
    const settings = readAffiliateSettingsSync(db);
    const user = db.get(`SELECT id, email, displayName, createdAt FROM users WHERE id = ?`, [userId]);
    const wallet = walletSync(db, userId);
    const referrals = db.all(
      `SELECT u.id, u.email, u.createdAt AS signedUpAt
         FROM users u WHERE u.referredByUserId = ? ORDER BY u.createdAt DESC LIMIT 50`,
      [userId]
    );
    const commissions = db.all(
      `SELECT * FROM affiliateCommissions WHERE affiliateUserId = ? ORDER BY createdAt DESC LIMIT 50`,
      [userId]
    );
    const withdrawals = db.all(
      `SELECT * FROM affiliateWithdrawals WHERE userId = ? ORDER BY createdAt DESC LIMIT 50`,
      [userId]
    );
    return {
      affiliate: row,
      user,
      effective: effectiveTermsSync(row, settings),
      wallet,
      payout: payoutDetailsSync(db, userId),
      referrals,
      commissions,
      withdrawals,
    };
  });
}

/**
 * Admin edit of an affiliate: overrides, block switch, note (design D8).
 * Every write is audited on the affiliate's account.
 */
export async function updateAffiliate(userId, patch, { actor = "admin", reason = null } = {}) {
  const db = await getAdapter();
  return db.transaction(() => {
    const before = getAffiliateSync(db, userId);
    if (!before) return null;

    const sets = [];
    const values = [];
    for (const key of ["rateBp", "maxOrders", "giftCodeId", "status", "adminNote"]) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      sets.push(`${key} = ?`);
      values.push(patch[key]);
    }
    if (sets.length === 0) return before;

    const at = nowIso();
    db.run(`UPDATE affiliates SET ${sets.join(", ")}, updatedAt = ? WHERE userId = ?`, [...values, at, userId]);

    insertAuditSync(db, {
      userId,
      actor,
      action: "affiliate_updated",
      reason,
      details: {
        before: {
          rateBp: before.rateBp, maxOrders: before.maxOrders,
          giftCodeId: before.giftCodeId, status: before.status, adminNote: before.adminNote,
        },
        after: patch,
      },
      now: at,
    });

    return getAffiliateSync(db, userId);
  });
}

/** Every commission, filterable by affiliate and status (admin list). */
export async function listCommissions({ affiliateUserId = "", status = "", limit = 50, offset = 0 } = {}) {
  const db = await getAdapter();
  const take = Math.min(Math.max(1, Math.floor(Number(limit) || 50)), 100);
  const skip = Math.max(0, Math.floor(Number(offset) || 0));
  // A hold that ended must read "Khả dụng" here even if nobody opened that wallet.
  db.transaction(() => releaseAllDueSync(db));

  const where = [];
  const params = [];
  if (affiliateUserId) {
    where.push(`c.affiliateUserId = ?`);
    params.push(affiliateUserId);
  }
  if (["pending", "available", "reversed"].includes(status)) {
    where.push(`c.status = ?`);
    params.push(status);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = Number(db.get(`SELECT COUNT(*) AS n FROM affiliateCommissions c ${whereSql}`, params)?.n ?? 0);
  const rows = db.all(
    `SELECT c.*, a.email AS affiliateEmail, af.code AS affiliateCode, r.email AS buyerEmail
       FROM affiliateCommissions c
       LEFT JOIN users a ON a.id = c.affiliateUserId
       LEFT JOIN affiliates af ON af.userId = c.affiliateUserId
       LEFT JOIN users r ON r.id = c.referredUserId
       ${whereSql}
      ORDER BY c.createdAt DESC, c.rowid DESC LIMIT ? OFFSET ?`,
    [...params, take, skip]
  );
  return { rows, total };
}

/** Every withdrawal, filterable by status (admin list). */
export async function listWithdrawals({ status = "", limit = 50, offset = 0 } = {}) {
  const db = await getAdapter();
  const take = Math.min(Math.max(1, Math.floor(Number(limit) || 50)), 100);
  const skip = Math.max(0, Math.floor(Number(offset) || 0));

  const where = [];
  const params = [];
  if (["pending", "paid", "rejected"].includes(status)) {
    where.push(`w.status = ?`);
    params.push(status);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = Number(db.get(`SELECT COUNT(*) AS n FROM affiliateWithdrawals w ${whereSql}`, params)?.n ?? 0);
  const rows = db.all(
    `SELECT w.*, COALESCE(u.email, w.emailSnapshot) AS email, u.displayName
       FROM affiliateWithdrawals w
       LEFT JOIN users u ON u.id = w.userId
       ${whereSql}
      ORDER BY w.createdAt DESC, w.rowid DESC LIMIT ? OFFSET ?`,
    [...params, take, skip]
  );
  const pendingCount = Number(
    db.get(`SELECT COUNT(*) AS n FROM affiliateWithdrawals WHERE status = 'pending'`)?.n ?? 0
  );
  return { rows, total, pendingCount };
}

/** Admin decision on one withdrawal (paid / rejected). Null = already decided. */
export async function decideWithdrawal(id, decision, { actor = "admin" } = {}) {
  const db = await getAdapter();
  return db.transaction(() => decideWithdrawalSync(db, id, { ...decision, actor }));
}

/** Admin wallet adjustment with a mandatory reason. */
export async function adjustWallet(userId, adjustment, { actor = "admin" } = {}) {
  const db = await getAdapter();
  return db.transaction(() => adjustWalletSync(db, userId, adjustment, { actor }));
}

/**
 * Admin set/clear of an account's referrer (design D8). Never creates commission
 * retroactively: it only writes `users.referredByUserId` and an audit row.
 */
export async function setUserReferrer(userId, referrerUserId, { actor = "admin", reason } = {}) {
  const db = await getAdapter();
  return db.transaction(() => {
    const user = db.get(`SELECT id, referredByUserId FROM users WHERE id = ?`, [userId]);
    if (!user) return { error: "not_found" };
    if (referrerUserId && referrerUserId === userId) return { error: "self" };
    if (referrerUserId) {
      const referrer = db.get(`SELECT id FROM users WHERE id = ?`, [referrerUserId]);
      if (!referrer) return { error: "unknown_referrer" };
      // Accrual needs the referrer's affiliates row. A referrer who never opened
      // /account/affiliate has none, and without this every later order of the
      // account would silently earn nothing.
      ensureAffiliateSync(db, referrerUserId);
    }

    const at = nowIso();
    db.run(`UPDATE users SET referredByUserId = ?, referredAt = ?, updatedAt = ? WHERE id = ?`, [
      referrerUserId || null,
      referrerUserId ? at : null,
      at,
      userId,
    ]);

    insertAuditSync(db, {
      userId,
      actor,
      action: "referrer_changed",
      reason,
      details: { before: user.referredByUserId ?? null, after: referrerUserId || null },
      now: at,
    });

    return { referredByUserId: referrerUserId || null, referredAt: referrerUserId ? at : null };
  });
}

// Re-exported so a caller that already holds a transaction can use the sync core
// without importing src/lib/affiliate/* twice.
export { accrueCommissionSync, releaseDueSync, releaseAllDueSync, walletSync };
