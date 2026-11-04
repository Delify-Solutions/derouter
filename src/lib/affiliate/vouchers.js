// Affiliate vouchers (spec affiliate-program "Vouchers", "Voucher at checkout").
//
// An affiliate turns wallet money into a single-use code anyone can enter when
// buying a plan. The value comes off the order price (converted at the admin rate
// across currencies); any remainder is lost.
//
// A voucher is "held" by the order that uses it (`heldByOrderId`). The hold lapses
// on its own once that order is no longer pending, so an expired or cancelled
// order needs no hook to free it. Cancelling (refund to the wallet) additionally
// refuses while the holder is pending OR expired, because an admin can still
// approve an expired order late.
//
// SYNCHRONOUS + DRIVER-FREE: takes the adapter first, runs in the caller's
// transaction. Relative imports only.
import { randomInt } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { insertAuditSync } from "../billing/audit.js";
import { readAffiliateSettingsSync } from "./settings.js";
import { WalletError, insertLedgerSync, nanoUsdToVnd, spendSync, vndToNanoUsd } from "./wallet.js";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const VOUCHER_CODE_LENGTH = 12;

function nowIso() {
  return new Date().toISOString();
}

/** Upper case, letters and digits only — what a customer may have typed. */
export function normalizeVoucherCode(input) {
  return String(input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function generateCode() {
  let out = "";
  for (let i = 0; i < VOUCHER_CODE_LENGTH; i += 1) out += ALPHABET[randomInt(0, ALPHABET.length)];
  return out;
}

/** A code no voucher and no gift code uses (a customer must not confuse the two). */
function freshCodeSync(db) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = generateCode();
    const taken = db.get(`SELECT 1 AS x FROM affiliateVouchers WHERE code = ?`, [code])
      || db.get(`SELECT 1 AS x FROM giftCodes WHERE code = ?`, [code]);
    if (!taken) return code;
  }
  throw new Error("Could not allocate a voucher code");
}

/** Create a voucher from the wallet (same rules as a conversion, no template needed). */
export function createVoucherSync(db, userId, { currency, amount }, { now = null } = {}) {
  const at = now || nowIso();
  const code = freshCodeSync(db);
  const id = uuidv4();
  const spent = spendSync(db, userId, { currency, amount }, { kind: "voucher", meta: { voucherId: id }, now: at });
  db.run(
    `INSERT INTO affiliateVouchers(id, code, ownerUserId, currency, amount, status, createdAt)
     VALUES(?, ?, ?, ?, ?, 'active', ?)`,
    [id, code, userId, spent.currency, spent.amount, at]
  );
  insertAuditSync(db, {
    userId,
    actor: "customer",
    action: "affiliate_voucher_created",
    details: { voucherId: id, currency: spent.currency, amount: spent.amount },
    now: at,
  });
  return db.get(`SELECT * FROM affiliateVouchers WHERE id = ?`, [id]);
}

function holderStatusSync(db, voucher) {
  if (!voucher?.heldByOrderId) return null;
  return db.get(`SELECT status FROM orders WHERE id = ?`, [voucher.heldByOrderId])?.status ?? null;
}

/**
 * Cancel an unused voucher and return its value to the owner's wallet.
 * @throws {WalletError} 404 when not the owner's, 409 when it can no longer change
 */
export function cancelVoucherSync(db, userId, voucherId, { now = null, actor = "customer" } = {}) {
  const at = now || nowIso();
  const voucher = db.get(`SELECT * FROM affiliateVouchers WHERE id = ? AND ownerUserId = ?`, [voucherId, userId]);
  if (!voucher) throw new WalletError("not_found", "Không tìm thấy voucher", 404);
  if (voucher.status !== "active") throw new WalletError("not_active", "Voucher đã dùng hoặc đã hủy", 409);
  // EVERY order that used this voucher counts, not only the current holder: a
  // newer order takes over `heldByOrderId`, but an older expired one can still be
  // approved late by an admin and would then be honoured after the refund.
  const open = db.get(
    `SELECT 1 AS x FROM orders WHERE voucherId = ? AND status IN ('pending', 'expired') LIMIT 1`,
    [voucherId]
  );
  if (open) {
    throw new WalletError("held", "Voucher đang gắn với một đơn chưa xong, chưa hủy được", 409);
  }
  const result = db.run(
    `UPDATE affiliateVouchers SET status = 'cancelled', cancelledAt = ? WHERE id = ? AND status = 'active'`,
    [at, voucherId]
  );
  if (result && typeof result.changes === "number" && result.changes === 0) {
    throw new WalletError("not_active", "Voucher đã dùng hoặc đã hủy", 409);
  }
  insertLedgerSync(db, {
    userId,
    currency: voucher.currency,
    delta: Number(voucher.amount),
    kind: "voucher_cancelled",
    meta: { voucherId },
    now: at,
  });
  insertAuditSync(db, {
    userId,
    actor,
    action: "affiliate_voucher_cancelled",
    details: { voucherId, currency: voucher.currency, amount: Number(voucher.amount) },
    now: at,
  });
  return db.get(`SELECT * FROM affiliateVouchers WHERE id = ?`, [voucherId]);
}

/** The voucher a code names, when it may be used by a new order right now; else null. */
export function usableVoucherSync(db, code) {
  const key = normalizeVoucherCode(code);
  if (!key) return null;
  const voucher = db.get(`SELECT * FROM affiliateVouchers WHERE code = ?`, [key]);
  if (!voucher || voucher.status !== "active") return null;
  if (holderStatusSync(db, voucher) === "pending") return null;
  return voucher;
}

/**
 * What a voucher takes off an order paid in `payCurrency`, capped at `payAmount`.
 * Cross-currency at the admin rate, floored in BigInt.
 */
export function voucherDiscountFor(voucher, { payCurrency, payAmount, vndPerUsd }) {
  const orderVnd = payCurrency === "VND";
  let value = Number(voucher.amount) || 0;
  if (voucher.currency === "VND" && !orderVnd) value = vndToNanoUsd(value, vndPerUsd);
  else if (voucher.currency === "USD" && orderVnd) value = nanoUsdToVnd(value, vndPerUsd);
  return Math.max(0, Math.min(value, Math.max(0, Number(payAmount) || 0)));
}

/** Hold a voucher for an order (called when the order row exists). */
export function holdVoucherSync(db, voucherId, orderId) {
  db.run(`UPDATE affiliateVouchers SET heldByOrderId = ? WHERE id = ? AND status = 'active'`, [orderId, voucherId]);
}

/**
 * The order was approved: its voucher is spent. Only an `active` voucher changes,
 * so a repeat approval (or a voucher cancelled in a race) changes nothing.
 */
export function markVoucherUsedSync(db, orderRow, { now = null } = {}) {
  if (!orderRow?.voucherId) return false;
  const result = db.run(
    `UPDATE affiliateVouchers
        SET status = 'used', usedOrderId = ?, usedByUserId = ?, usedAt = ?, heldByOrderId = ?
      WHERE id = ? AND status = 'active'`,
    [orderRow.id, orderRow.userId, now || nowIso(), orderRow.id, orderRow.voucherId]
  );
  return !(result && typeof result.changes === "number" && result.changes === 0);
}

/** Rate used for cross-currency vouchers, read in the same transaction. */
export function voucherRateSync(db, settings = null) {
  const s = settings || readAffiliateSettingsSync(db);
  return Number(s.affiliateVndPerUsd) || 0;
}
