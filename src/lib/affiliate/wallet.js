// Commission wallet: balances, withdrawals and admin adjustments (design D5).
//
// SYNCHRONOUS + DRIVER-FREE. Every function takes the adapter first and is meant
// to run inside the caller's `db.transaction`, which is what makes "two requests
// for the same full balance" safe: the checks and the reservation are one write.
//
// Balance = SUM(affiliateLedger.delta) per (userId, currency). Only released
// commission reaches the ledger; held money stays in affiliateCommissions.
import { v4 as uuidv4 } from "uuid";
import { insertAuditSync } from "../billing/audit.js";
import { parseJson, stringifyJson } from "../db/helpers/jsonCol.js";
import { readAffiliateSettingsSync, toWholeNumber } from "./settings.js";
import { getAffiliateSync } from "./core.js";
import { releaseAllDueSync, releaseDueSync } from "./commission.js";

export const WITHDRAW_CURRENCIES = ["VND", "USD"];

function nowIso() {
  return new Date().toISOString();
}

export class WalletError extends Error {
  constructor(reason, message, status = 400) {
    super(message);
    this.name = "WalletError";
    this.reason = reason;
    this.status = status;
  }
}

function emptyCurrency() {
  return { available: 0, pending: 0, earned: 0, withdrawn: 0 };
}

function insertLedgerSync(db, { userId, currency, delta, kind, withdrawalId = null, commissionId = null, meta = null, now }) {
  db.run(
    `INSERT INTO affiliateLedger(userId, currency, delta, kind, commissionId, withdrawalId, meta, createdAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, currency, delta, kind, commissionId, withdrawalId, meta == null ? null : stringifyJson(meta), now]
  );
}

/**
 * One affiliate's wallet, per currency (spec "Commission wallet").
 *
 * Releases due commissions first, so the number returned is always correct at the
 * moment it is read (design D3). Must therefore run in a WRITE transaction.
 *
 *   available  ledger sum — what can be withdrawn (may be negative after a
 *              refund that landed post-payout)
 *   pending    held commission not yet released
 *   earned     lifetime commission still standing (pending + available). A
 *              reversed commission was never really earned, so it is excluded;
 *              a negative balance after a post-payout refund shows in `available`
 *              instead.
 *   withdrawn  lifetime amount reserved by withdrawals (paid or still pending)
 *
 * @returns {{ VND: object, USD: object }}
 */
export function walletSync(db, userId, now = null) {
  if (!db) throw new Error("walletSync requires the db adapter");
  const at = now || nowIso();
  const wallet = { VND: emptyCurrency(), USD: emptyCurrency() };
  if (!userId) return wallet;

  releaseDueSync(db, userId, at);

  const ledgerRows = db.all(
    `SELECT currency, COALESCE(SUM(delta), 0) AS total
       FROM affiliateLedger WHERE userId = ? GROUP BY currency`,
    [userId]
  );
  for (const row of ledgerRows) {
    if (!wallet[row.currency]) continue;
    wallet[row.currency].available = Number(row.total) || 0;
  }

  const pendingRows = db.all(
    `SELECT currency, COALESCE(SUM(amount), 0) AS total
       FROM affiliateCommissions
      WHERE affiliateUserId = ? AND status = 'pending' GROUP BY currency`,
    [userId]
  );
  for (const row of pendingRows) {
    if (!wallet[row.currency]) continue;
    wallet[row.currency].pending = Number(row.total) || 0;
  }

  const earnedRows = db.all(
    `SELECT currency, COALESCE(SUM(amount), 0) AS total
       FROM affiliateCommissions
      WHERE affiliateUserId = ? AND status IN ('pending', 'available') GROUP BY currency`,
    [userId]
  );
  for (const row of earnedRows) {
    if (!wallet[row.currency]) continue;
    wallet[row.currency].earned = Number(row.total) || 0;
  }

  const withdrawnRows = db.all(
    `SELECT currency, COALESCE(SUM(amount), 0) AS total
       FROM affiliateWithdrawals
      WHERE userId = ? AND status IN ('pending', 'paid') GROUP BY currency`,
    [userId]
  );
  for (const row of withdrawnRows) {
    if (!wallet[row.currency]) continue;
    wallet[row.currency].withdrawn = Number(row.total) || 0;
  }

  return wallet;
}

/**
 * Wallets for a page of affiliates in a fixed number of queries (design D3: the
 * admin list runs `releaseAllDueSync` first, never one release per row).
 *
 * @param {object} db adapter (inside a write transaction, for the release)
 * @param {string[]} userIds
 * @param {string=} now
 * @returns {Map<string, {VND: object, USD: object}>}
 */
export function walletsSync(db, userIds, now = null) {
  if (!db) throw new Error("walletsSync requires the db adapter");
  const at = now || nowIso();
  const out = new Map();
  const ids = Array.isArray(userIds) ? userIds.filter(Boolean) : [];
  if (ids.length === 0) return out;

  releaseAllDueSync(db, at);

  const placeholders = ids.map(() => "?").join(", ");
  for (const id of ids) out.set(id, { VND: emptyCurrency(), USD: emptyCurrency() });

  const ledgerRows = db.all(
    `SELECT userId, currency, COALESCE(SUM(delta), 0) AS total
       FROM affiliateLedger WHERE userId IN (${placeholders}) GROUP BY userId, currency`,
    ids
  );
  for (const row of ledgerRows) {
    const entry = out.get(row.userId);
    if (entry?.[row.currency]) entry[row.currency].available = Number(row.total) || 0;
  }

  const pendingRows = db.all(
    `SELECT affiliateUserId AS userId, currency, COALESCE(SUM(amount), 0) AS total
       FROM affiliateCommissions
      WHERE affiliateUserId IN (${placeholders}) AND status = 'pending'
      GROUP BY affiliateUserId, currency`,
    ids
  );
  for (const row of pendingRows) {
    const entry = out.get(row.userId);
    if (entry?.[row.currency]) entry[row.currency].pending = Number(row.total) || 0;
  }

  const earnedRows = db.all(
    `SELECT affiliateUserId AS userId, currency, COALESCE(SUM(amount), 0) AS total
       FROM affiliateCommissions
      WHERE affiliateUserId IN (${placeholders}) AND status IN ('pending', 'available')
      GROUP BY affiliateUserId, currency`,
    ids
  );
  for (const row of earnedRows) {
    const entry = out.get(row.userId);
    if (entry?.[row.currency]) entry[row.currency].earned = Number(row.total) || 0;
  }

  const withdrawnRows = db.all(
    `SELECT userId, currency, COALESCE(SUM(amount), 0) AS total
       FROM affiliateWithdrawals
      WHERE userId IN (${placeholders}) AND status IN ('pending', 'paid')
      GROUP BY userId, currency`,
    ids
  );
  for (const row of withdrawnRows) {
    const entry = out.get(row.userId);
    if (entry?.[row.currency]) entry[row.currency].withdrawn = Number(row.total) || 0;
  }

  return out;
}

/** Payout details of an affiliate, parsed. `{ vnd, usd }`, either may be null. */
export function payoutDetailsSync(db, userId) {
  const row = getAffiliateSync(db, userId);
  return {
    vnd: parseJson(row?.payoutVnd, null) || null,
    usd: parseJson(row?.payoutUsd, null) || null,
  };
}

const PAYOUT_FIELDS_VND = ["bankName", "accountNumber", "accountName"];
const PAYOUT_FIELDS_USD = ["network", "address"];

/**
 * Save the payout destination for one currency (spec "Payout details").
 * Every VND field is required; USD needs an address and a network.
 */
export function savePayoutSync(db, userId, currency, details) {
  const affiliate = getAffiliateSync(db, userId);
  if (!affiliate) throw new WalletError("no_affiliate", "Bạn chưa có mã giới thiệu", 404);

  const clean = {};
  if (currency === "VND") {
    for (const field of PAYOUT_FIELDS_VND) {
      const value = typeof details?.[field] === "string" ? details[field].trim() : "";
      if (!value) throw new WalletError("missing_field", "Nhập đủ tên ngân hàng, số tài khoản và chủ tài khoản");
      if (value.length > 100) throw new WalletError("too_long", "Mỗi trường tối đa 100 ký tự");
      clean[field] = value;
    }
    db.run(`UPDATE affiliates SET payoutVnd = ?, updatedAt = ? WHERE userId = ?`, [
      stringifyJson(clean),
      nowIso(),
      userId,
    ]);
  } else if (currency === "USD") {
    const network = typeof details?.network === "string" ? details.network.trim().toUpperCase() : "";
    const address = typeof details?.address === "string" ? details.address.trim() : "";
    if (!address) throw new WalletError("missing_field", "Nhập địa chỉ USDT hoặc Binance ID");
    if (!network) throw new WalletError("missing_field", "Chọn mạng (TRC20 hoặc BEP20)");
    if (address.length > 100) throw new WalletError("too_long", "Địa chỉ tối đa 100 ký tự");
    clean.network = network;
    clean.address = address;
    db.run(`UPDATE affiliates SET payoutUsd = ?, updatedAt = ? WHERE userId = ?`, [
      stringifyJson(clean),
      nowIso(),
      userId,
    ]);
  } else {
    throw new WalletError("bad_currency", "Đơn vị tiền không hợp lệ");
  }

  return clean;
}

function minimumFor(settings, currency) {
  return currency === "VND"
    ? Number(settings.affiliateMinWithdrawVnd ?? 0)
    : Number(settings.affiliateMinWithdrawUsdNano ?? 0);
}

/**
 * Request a withdrawal (design D5 / spec "Withdrawal request").
 *
 * Every rule is checked here, in the caller's transaction, then the amount is
 * RESERVED with a negative ledger row. Two requests for the full balance
 * therefore serialise: the second sees the balance the first left.
 *
 * @returns {object} the inserted withdrawal row
 * @throws {WalletError} 400/403 with the Vietnamese reason
 */
export function requestWithdrawalSync(db, userId, { currency, amount }, { now = null } = {}) {
  if (!db) throw new Error("requestWithdrawalSync requires the db adapter");
  const at = now || nowIso();

  const cur = String(currency || "").toUpperCase();
  if (!WITHDRAW_CURRENCIES.includes(cur)) {
    throw new WalletError("bad_currency", "Đơn vị tiền không hợp lệ");
  }

  const settings = readAffiliateSettingsSync(db);
  // With the program off the customer page shows the wallet and history only
  // (spec "Program settings"); the API must agree with the page.
  if (settings.affiliateEnabled !== true) {
    throw new WalletError("program_disabled", "Chương trình giới thiệu đang tạm dừng nên chưa rút được", 403);
  }
  const affiliate = getAffiliateSync(db, userId);
  if (!affiliate) throw new WalletError("no_affiliate", "Bạn chưa có mã giới thiệu", 404);
  if (affiliate.status !== "active") {
    throw new WalletError("blocked", "Tài khoản của bạn đang bị khóa giới thiệu", 403);
  }

  const payout = payoutDetailsSync(db, userId);
  const destination = cur === "VND" ? payout.vnd : payout.usd;
  if (!destination) {
    throw new WalletError("no_payout", "Lưu thông tin nhận tiền trước khi rút");
  }

  // Plain digits or an integer only: Number("100.000") is 100, Number("1e5") is
  // 100000, Number(true) is 1 — a direct API call must not get any of those.
  const value = toWholeNumber(amount);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WalletError("bad_amount", "Số tiền phải là số nguyên dương");
  }
  const minimum = minimumFor(settings, cur);
  if (value < minimum) {
    const label = cur === "VND"
      ? `${minimum.toLocaleString("vi-VN")}đ`
      : `${(minimum / 1_000_000_000).toFixed(2)} USD`;
    throw new WalletError("below_minimum", `Số tiền rút tối thiểu là ${label}`);
  }

  // Release due commissions first: money that became available while the page was
  // open must be withdrawable, and the balance below must be the current one.
  const wallet = walletSync(db, userId, at);
  const available = wallet[cur].available;
  if (available <= 0) {
    throw new WalletError("insufficient", "Số dư khả dụng không đủ để rút");
  }
  if (value > available) {
    throw new WalletError("insufficient", "Số dư khả dụng không đủ để rút");
  }

  const open = db.get(
    `SELECT 1 AS x FROM affiliateWithdrawals WHERE userId = ? AND currency = ? AND status = 'pending'`,
    [userId, cur]
  );
  if (open) {
    throw new WalletError("pending_exists", "Bạn đang có một lệnh rút chờ xử lý cho đơn vị này");
  }

  const user = db.get(`SELECT email FROM users WHERE id = ?`, [userId]);
  const id = uuidv4();
  db.run(
    `INSERT INTO affiliateWithdrawals(
       id, userId, emailSnapshot, currency, amount, destination, status, createdAt
     ) VALUES(?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [id, userId, user?.email ?? null, cur, value, stringifyJson(destination), at]
  );

  insertLedgerSync(db, {
    userId,
    currency: cur,
    delta: -value,
    kind: "withdrawal",
    withdrawalId: id,
    now: at,
  });

  return db.get(`SELECT * FROM affiliateWithdrawals WHERE id = ?`, [id]);
}

/**
 * Admin decision on a pending withdrawal (design D5 / spec "Admin decides
 * withdrawals"). The `status = 'pending'` guard is what makes a double decision
 * impossible: the loser changes 0 rows and gets `null`, which the route maps to 409.
 *
 * @returns {object|null} the updated row, or null when it was already decided
 */
export function decideWithdrawalSync(db, id, { action, txRef = null, reason = null, actor = "admin" }, { now = null } = {}) {
  if (!db) throw new Error("decideWithdrawalSync requires the db adapter");
  const at = now || nowIso();
  const row = db.get(`SELECT * FROM affiliateWithdrawals WHERE id = ?`, [id]);
  if (!row) throw new WalletError("not_found", "Không tìm thấy lệnh rút", 404);
  if (row.status !== "pending") return null;

  if (action === "paid") {
    const ref = typeof txRef === "string" ? txRef.trim() : "";
    if (!ref) throw new WalletError("missing_txref", "Nhập mã giao dịch chuyển khoản");
    if (ref.length > 200) throw new WalletError("too_long", "Mã giao dịch tối đa 200 ký tự");
    const result = db.run(
      `UPDATE affiliateWithdrawals
          SET status = 'paid', txRef = ?, adminNote = ?, decidedBy = ?, decidedAt = ?
        WHERE id = ? AND status = 'pending'`,
      [ref, reason, actor, at, id]
    );
    if (result && typeof result.changes === "number" && result.changes === 0) return null;
  } else if (action === "rejected") {
    const note = typeof reason === "string" ? reason.trim() : "";
    if (!note) throw new WalletError("missing_reason", "Nhập lý do từ chối");
    if (note.length > 500) throw new WalletError("too_long", "Lý do tối đa 500 ký tự");
    const result = db.run(
      `UPDATE affiliateWithdrawals
          SET status = 'rejected', adminNote = ?, decidedBy = ?, decidedAt = ?
        WHERE id = ? AND status = 'pending'`,
      [note, actor, at, id]
    );
    if (result && typeof result.changes === "number" && result.changes === 0) return null;
    // The reserve comes back in the same transaction.
    insertLedgerSync(db, {
      userId: row.userId,
      currency: row.currency,
      delta: Number(row.amount),
      kind: "withdrawal_rejected",
      withdrawalId: id,
      meta: { reason: note },
      now: at,
    });
  } else {
    throw new WalletError("bad_action", "Hành động không hợp lệ");
  }

  insertAuditSync(db, {
    userId: row.userId,
    actor,
    action: action === "paid" ? "affiliate_withdrawal_paid" : "affiliate_withdrawal_rejected",
    reason: reason ?? null,
    details: { withdrawalId: id, currency: row.currency, amount: Number(row.amount), txRef: txRef ?? null },
    now: at,
  });

  return db.get(`SELECT * FROM affiliateWithdrawals WHERE id = ?`, [id]);
}

/**
 * Admin wallet adjustment (spec "Admin wallet adjustment", design D8). The reason
 * is mandatory and `delta` must be a non-zero integer: an adjustment with no
 * explanation is indistinguishable from a bug.
 */
export function adjustWalletSync(db, userId, { currency, delta, reason }, { actor = "admin", now = null } = {}) {
  if (!db) throw new Error("adjustWalletSync requires the db adapter");
  const at = now || nowIso();
  const cur = String(currency || "").toUpperCase();
  if (!WITHDRAW_CURRENCIES.includes(cur)) {
    throw new WalletError("bad_currency", "Đơn vị tiền không hợp lệ");
  }
  // Signed whole number only (same reason as the withdrawal amount above).
  const raw = typeof delta === "string" ? delta.trim() : delta;
  const negative = typeof raw === "string" && raw.startsWith("-");
  const magnitude = toWholeNumber(typeof raw === "string" ? raw.replace(/^[+-]/, "") : raw);
  const value = negative ? -magnitude : magnitude;
  if (!Number.isSafeInteger(value) || value === 0) {
    throw new WalletError("bad_delta", "Số tiền điều chỉnh phải là số nguyên khác 0");
  }
  const note = typeof reason === "string" ? reason.trim() : "";
  if (!note) throw new WalletError("missing_reason", "Nhập lý do điều chỉnh");
  if (note.length > 500) throw new WalletError("too_long", "Lý do tối đa 500 ký tự");
  if (!getAffiliateSync(db, userId)) {
    throw new WalletError("no_affiliate", "Tài khoản này chưa có mã giới thiệu", 404);
  }

  insertLedgerSync(db, {
    userId,
    currency: cur,
    delta: value,
    kind: "adjust",
    meta: { reason: note, admin: actor },
    now: at,
  });

  insertAuditSync(db, {
    userId,
    actor,
    action: "affiliate_wallet_adjusted",
    reason: note,
    details: { currency: cur, delta: value },
    now: at,
  });

  return walletSync(db, userId, at);
}
