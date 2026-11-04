// Commission wallet: balances, spending and admin adjustments
// (spec affiliate-program "Commission wallet", change affiliate-credit-vouchers).
//
// Commission is never paid out. The balance can only be spent inside the service:
// converted into API credit (convertToCreditSync) or turned into a single-use
// voucher (vouchers.js). Both spend through spendSync, which checks and debits in
// the caller's transaction, so two spends of the same full balance cannot both
// succeed.
//
// SYNCHRONOUS + DRIVER-FREE: every function takes the adapter first and runs
// inside the caller's `db.transaction`. Relative imports only.
//
// Balance = SUM(affiliateLedger.delta) per (userId, currency). Only released
// commission reaches the ledger; held money stays in affiliateCommissions.
import { insertAuditSync } from "../billing/audit.js";
import { grantUserPlan } from "../billing/grants.js";
import { parseLimits } from "../billing/limits.js";
import { stringifyJson } from "../db/helpers/jsonCol.js";
import { readAffiliateSettingsSync, toWholeNumber } from "./settings.js";
import { getAffiliateSync } from "./core.js";
import { releaseAllDueSync, releaseDueSync } from "./commission.js";

export const WALLET_CURRENCIES = ["VND", "USD"];

/** Ledger kinds that spend the wallet; their negated sum is the "spent" figure. */
const SPEND_KINDS = ["convert_credit", "voucher", "voucher_cancelled"];

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
  return { available: 0, pending: 0, earned: 0, spent: 0 };
}

export function insertLedgerSync(db, { userId, currency, delta, kind, commissionId = null, meta = null, now }) {
  db.run(
    `INSERT INTO affiliateLedger(userId, currency, delta, kind, commissionId, withdrawalId, meta, createdAt)
     VALUES(?, ?, ?, ?, ?, NULL, ?, ?)`,
    [userId, currency, delta, kind, commissionId, meta == null ? null : stringifyJson(meta), now]
  );
}

/**
 * `vnd` đồng → nano-USD of credit at `vndPerUsd` đồng per $1, floored, in BigInt
 * (đồng × 1e9 overflows 2^53 from about 9 million đồng).
 */
export function vndToNanoUsd(vnd, vndPerUsd) {
  const rate = BigInt(Math.trunc(Number(vndPerUsd) || 0));
  const amount = BigInt(Math.trunc(Number(vnd) || 0));
  if (rate <= 0n || amount <= 0n) return 0;
  const out = (amount * 1_000_000_000n) / rate;
  return Number(out > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : out);
}

/** nano-USD → đồng at `vndPerUsd`, floored, in BigInt. */
export function nanoUsdToVnd(nanoUsd, vndPerUsd) {
  const rate = BigInt(Math.trunc(Number(vndPerUsd) || 0));
  const amount = BigInt(Math.trunc(Number(nanoUsd) || 0));
  if (rate <= 0n || amount <= 0n) return 0;
  return Number((amount * rate) / 1_000_000_000n);
}

function sumsInto(target, rows, field) {
  for (const row of rows) {
    const entry = target(row);
    if (entry?.[row.currency]) entry[row.currency][field] = Number(row.total) || 0;
  }
}

/**
 * One affiliate's wallet, per currency (spec "Commission wallet").
 *
 * Releases due commissions first, so the number returned is always correct at the
 * moment it is read (design D3 of affiliate-referrals). Must therefore run in a
 * WRITE transaction.
 *
 *   available  ledger sum — what can be spent (negative after a refund that
 *              landed after the commission was spent)
 *   pending    held commission not yet released
 *   earned     lifetime commission still standing (pending + available)
 *   spent      lifetime converted to credit or put into vouchers, net of
 *              cancelled vouchers
 */
export function walletSync(db, userId, now = null) {
  if (!db) throw new Error("walletSync requires the db adapter");
  const at = now || nowIso();
  if (!userId) return { VND: emptyCurrency(), USD: emptyCurrency() };
  releaseDueSync(db, userId, at);
  return readWalletsSync(db, [userId]).get(userId);
}

/**
 * Wallets for a page of affiliates in a fixed number of queries (the admin list
 * runs `releaseAllDueSync` first, never one release per row).
 */
export function walletsSync(db, userIds, now = null) {
  if (!db) throw new Error("walletsSync requires the db adapter");
  const ids = Array.isArray(userIds) ? userIds.filter(Boolean) : [];
  if (ids.length === 0) return new Map();
  releaseAllDueSync(db, now || nowIso());
  return readWalletsSync(db, ids);
}

function readWalletsSync(db, ids) {
  const out = new Map();
  for (const id of ids) out.set(id, { VND: emptyCurrency(), USD: emptyCurrency() });
  const marks = ids.map(() => "?").join(", ");
  const byUser = (row) => out.get(row.userId);

  sumsInto(byUser, db.all(
    `SELECT userId, currency, COALESCE(SUM(delta), 0) AS total
       FROM affiliateLedger WHERE userId IN (${marks}) GROUP BY userId, currency`,
    ids
  ), "available");
  sumsInto(byUser, db.all(
    `SELECT affiliateUserId AS userId, currency, COALESCE(SUM(amount), 0) AS total
       FROM affiliateCommissions
      WHERE affiliateUserId IN (${marks}) AND status = 'pending'
      GROUP BY affiliateUserId, currency`,
    ids
  ), "pending");
  sumsInto(byUser, db.all(
    `SELECT affiliateUserId AS userId, currency, COALESCE(SUM(amount), 0) AS total
       FROM affiliateCommissions
      WHERE affiliateUserId IN (${marks}) AND status IN ('pending', 'available')
      GROUP BY affiliateUserId, currency`,
    ids
  ), "earned");
  sumsInto(byUser, db.all(
    `SELECT userId, currency, COALESCE(-SUM(delta), 0) AS total
       FROM affiliateLedger
      WHERE userId IN (${marks}) AND kind IN (${SPEND_KINDS.map(() => "?").join(", ")})
      GROUP BY userId, currency`,
    [...ids, ...SPEND_KINDS]
  ), "spent");
  return out;
}

function minimumFor(settings, currency) {
  return currency === "VND"
    ? Number(settings.affiliateMinRedeemVnd ?? 0)
    : Number(settings.affiliateMinRedeemUsdNano ?? 0);
}

function minimumLabel(currency, minimum) {
  return currency === "VND"
    ? `${minimum.toLocaleString("vi-VN")}đ`
    : `${(minimum / 1_000_000_000).toFixed(2)} USD`;
}

/**
 * Debit the wallet for a spend (conversion or voucher). Every rule is checked
 * here, in the caller's transaction, then one negative ledger row is written.
 *
 * @returns {{ currency: "VND"|"USD", amount: number, settings: object, affiliate: object }}
 * @throws {WalletError} 400/403 with the Vietnamese reason
 */
export function spendSync(db, userId, { currency, amount }, { kind, meta = null, now = null } = {}) {
  if (!db) throw new Error("spendSync requires the db adapter");
  if (!SPEND_KINDS.includes(kind) || kind === "voucher_cancelled") throw new Error(`spendSync: bad kind ${kind}`);
  const at = now || nowIso();

  const cur = String(currency || "").toUpperCase();
  if (!WALLET_CURRENCIES.includes(cur)) {
    throw new WalletError("bad_currency", "Đơn vị tiền không hợp lệ");
  }

  const settings = readAffiliateSettingsSync(db);
  if (settings.affiliateEnabled !== true) {
    throw new WalletError("program_disabled", "Chương trình giới thiệu đang tạm dừng", 403);
  }
  const affiliate = getAffiliateSync(db, userId);
  if (!affiliate) throw new WalletError("no_affiliate", "Bạn chưa có mã giới thiệu", 403);
  if (affiliate.status !== "active") {
    throw new WalletError("blocked", "Tài khoản của bạn đang bị khóa giới thiệu", 403);
  }

  // Plain digits or an integer only: Number("100.000") is 100, Number("1e5") is
  // 100000, Number(true) is 1 — a direct API call must not get any of those.
  const value = toWholeNumber(amount);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WalletError("bad_amount", "Số tiền phải là số nguyên dương");
  }
  const minimum = minimumFor(settings, cur);
  if (value < minimum) {
    throw new WalletError("below_minimum", `Số tiền tối thiểu mỗi lần là ${minimumLabel(cur, minimum)}`);
  }

  const wallet = walletSync(db, userId, at);
  const available = wallet[cur].available;
  if (available < 0) {
    throw new WalletError("negative_balance", "Số dư đang âm do đơn hoàn tiền, chưa dùng được");
  }
  if (value > available) {
    throw new WalletError("insufficient", "Số dư khả dụng không đủ");
  }

  insertLedgerSync(db, { userId, currency: cur, delta: -value, kind, meta, now: at });
  return { currency: cur, amount: value, settings, affiliate };
}

/** The template plan converted and bonus credit is granted against, or null. */
export function creditTemplatePlanSync(db, settings) {
  const id = settings?.affiliateCreditPlanId;
  if (!id) return null;
  return db.get(`SELECT * FROM plans WHERE id = ?`, [id]) ?? null;
}

/**
 * Grant `creditNanoUsd` as its own purchase against the template plan: the
 * plan's RPM/TPM (read live from the plan) and per-window limits (snapshotted),
 * never unlimited, expiring `affiliateCreditDays` after `now`. Shared by
 * conversions and the referred-buyer bonus.
 */
export function grantTemplateCreditSync(db, { userId, creditNanoUsd, source, settings, meta, now, orderId = null }) {
  const plan = creditTemplatePlanSync(db, settings);
  if (!plan) return null;
  const days = Math.max(1, Math.floor(Number(settings.affiliateCreditDays) || 30));
  const granted = grantUserPlan(db, {
    userId,
    planId: plan.id,
    // The buyer bonus carries its order, so refundOrder (which closes every
    // purchase with that orderId) takes the bonus back with the order.
    orderId,
    source,
    creditNanoUsd,
    unlimitedCredit: false,
    durationDays: days,
    limits: parseLimits(plan.limits),
    meta,
    now,
  });
  return { userPlan: granted.userPlan, plan, days };
}

/**
 * Convert wallet money into API credit (spec "Convert commission to credit").
 * VND converts at `affiliateVndPerUsd`, USD 1:1. Each call is a separate grant
 * with its own expiry; nothing is merged.
 *
 * @returns {{ userPlan: object, creditNanoUsd: number, currency: string, amount: number }}
 */
export function convertToCreditSync(db, userId, { currency, amount }, { now = null } = {}) {
  const at = now || nowIso();
  const settings = readAffiliateSettingsSync(db);
  if (settings.affiliateEnabled !== true) {
    throw new WalletError("program_disabled", "Chương trình giới thiệu đang tạm dừng", 403);
  }
  // Checked before spending so a refusal leaves the wallet untouched.
  if (!creditTemplatePlanSync(db, settings)) {
    throw new WalletError("no_template", "Quản trị viên chưa cấu hình gói cho credit giới thiệu", 400);
  }
  const cur = String(currency || "").toUpperCase();
  const parsed = toWholeNumber(amount);
  const credit = cur === "VND" ? vndToNanoUsd(parsed, settings.affiliateVndPerUsd) : parsed;
  if (Number.isSafeInteger(parsed) && parsed > 0 && !(credit > 0)) {
    throw new WalletError("too_small", "Số tiền quá nhỏ để đổi ra credit");
  }

  const spent = spendSync(db, userId, { currency, amount }, {
    kind: "convert_credit",
    meta: { creditNanoUsd: credit, vndPerUsd: cur === "VND" ? Number(settings.affiliateVndPerUsd) : null },
    now: at,
  });
  const granted = grantTemplateCreditSync(db, {
    userId,
    creditNanoUsd: credit,
    source: "affiliate",
    settings: spent.settings,
    meta: { affiliateConversion: true, currency: spent.currency, amount: spent.amount },
    now: at,
  });

  insertAuditSync(db, {
    userId,
    actor: "customer",
    action: "affiliate_credit_converted",
    details: {
      currency: spent.currency,
      amount: spent.amount,
      creditNanoUsd: credit,
      userPlanId: granted.userPlan.id,
      expiresAt: granted.userPlan.expiresAt,
    },
    now: at,
  });

  return { userPlan: granted.userPlan, creditNanoUsd: credit, currency: spent.currency, amount: spent.amount };
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
  if (!WALLET_CURRENCIES.includes(cur)) {
    throw new WalletError("bad_currency", "Đơn vị tiền không hợp lệ");
  }
  // Signed whole number only (same parsing as spendSync).
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
