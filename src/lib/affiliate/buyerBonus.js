// Referred-buyer bonus (spec affiliate-program "Referred-buyer bonus").
//
// A referred customer's first N paid orders each earn X% (effective terms:
// the referrer's override, else the program default):
//   - a plan with a credit amount: X% of that credit as a separate grant against
//     the template plan, decided when the order is approved;
//   - an unlimited plan: X% off the price, decided when the order is created.
//
// SYNCHRONOUS + DRIVER-FREE. Relative imports only.
import { readAffiliateSettingsSync } from "./settings.js";
import { getAffiliateSync } from "./core.js";
import { grantTemplateCreditSync } from "./wallet.js";

function nowIso() {
  return new Date().toISOString();
}

/**
 * `{ bp, maxOrders, referrerId }` for a buyer, or null when no bonus applies:
 * program off, no referrer, referrer deleted or blocked, or a rate of 0.
 */
export function buyerBonusTermsSync(db, buyerId, settings = null) {
  if (!buyerId) return null;
  const buyer = db.get(`SELECT id, referredByUserId FROM users WHERE id = ?`, [buyerId]);
  const referrerId = buyer?.referredByUserId;
  if (!referrerId || referrerId === buyerId) return null;
  return buyerBonusTermsForReferrerSync(db, referrerId, settings);
}

/** The bonus a referrer's link gives its referred buyers (register banner, terms). */
export function buyerBonusTermsForReferrerSync(db, referrerId, settings = null) {
  if (!referrerId) return null;
  const s = settings || readAffiliateSettingsSync(db);
  if (s.affiliateEnabled !== true) return null;
  if (!db.get(`SELECT id FROM users WHERE id = ?`, [referrerId])) return null;
  const affiliate = getAffiliateSync(db, referrerId);
  if (!affiliate || affiliate.status !== "active") return null;
  const bp = affiliate.buyerBonusBp == null ? Number(s.affiliateBuyerBonusBp ?? 0) : Number(affiliate.buyerBonusBp);
  const maxOrders = affiliate.buyerBonusMaxOrders == null
    ? Number(s.affiliateBuyerBonusMaxOrders ?? 0)
    : Number(affiliate.buyerBonusMaxOrders);
  if (!(bp > 0)) return null;
  return { bp, maxOrders, referrerId };
}

/** `floor(value × bp / 10000)` in BigInt. */
export function bpOf(value, bp) {
  const v = BigInt(Math.trunc(Number(value) || 0));
  const r = BigInt(Math.trunc(Number(bp) || 0));
  if (v <= 0n || r <= 0n) return 0;
  return Number((v * r) / 10_000n);
}

/**
 * Discount (basis points) for an UNLIMITED-plan order being created now, or 0.
 * Counts paid orders plus pending orders already carrying a referral discount,
 * so opening several pending orders cannot stretch "the first N".
 */
export function referralDiscountBpSync(db, buyerId, { unlimited, settings = null } = {}) {
  if (!unlimited) return 0;
  const terms = buyerBonusTermsSync(db, buyerId, settings);
  if (!terms) return 0;
  if (terms.maxOrders > 0) {
    const used = Number(db.get(
      `SELECT COUNT(*) AS n FROM orders
        WHERE userId = ? AND (status = 'paid' OR (status = 'pending' AND COALESCE(referralDiscountBp, 0) > 0))`,
      [buyerId]
    )?.n ?? 0);
    if (used >= terms.maxOrders) return 0;
  }
  return terms.bp;
}

/**
 * Bonus credit for a CREDIT-plan order that was just approved (called from
 * approveOrderSync, in its transaction). Returns the grant or null.
 */
export function grantBuyerBonusSync(db, orderRow, { now = null } = {}) {
  if (!orderRow?.id || !orderRow?.userId) return null;
  if (Number(orderRow.unlimitedCredit) === 1) return null; // got its discount at checkout
  const settings = readAffiliateSettingsSync(db);
  const terms = buyerBonusTermsSync(db, orderRow.userId, settings);
  if (!terms) return null;
  if (terms.maxOrders > 0) {
    // Same count as the unlimited-plan discount: other paid orders plus pending
    // orders that already reserved a referral discount, so N = 1 cannot yield
    // both a discount and a bonus.
    const earlier = Number(db.get(
      `SELECT COUNT(*) AS n FROM orders
        WHERE userId = ? AND id != ?
          AND (status = 'paid' OR (status = 'pending' AND COALESCE(referralDiscountBp, 0) > 0))`,
      [orderRow.userId, orderRow.id]
    )?.n ?? 0);
    if (earlier >= terms.maxOrders) return null;
  }
  const periods = Math.max(1, Math.floor(Number(orderRow.periods) || 1));
  const credit = bpOf(BigInt(Math.trunc(Number(orderRow.creditNanoUsd) || 0)) * BigInt(periods), terms.bp);
  if (!(credit > 0)) return null;
  return grantTemplateCreditSync(db, {
    userId: orderRow.userId,
    creditNanoUsd: credit,
    source: "referral_bonus",
    settings,
    meta: { orderId: orderRow.id, bonusBp: terms.bp },
    orderId: orderRow.id,
    now: now || nowIso(),
  });
}
