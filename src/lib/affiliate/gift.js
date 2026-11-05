// The referral welcome gift (design D7, spec "Referral welcome gift").
//
// An affiliate's effective `giftCodeId` may only be advertised while the code is
// usable. Eligibility is: the row exists, is flagged new-user, is active, is
// inside its window and is not exhausted — the same conditions `redeemGiftCode`
// enforces, read through the shared window helper so the two can never disagree.
//
// SYNCHRONOUS + DRIVER-FREE: takes the adapter first.
import { inWindow, giftExhausted } from "../gift/window.js";
import { effectiveTermsSync } from "./core.js";

/**
 * The gift code row a referrer may advertise, or null.
 *
 * @param {object} db adapter
 * @param {string|null} giftCodeId the effective override-or-default id
 * @param {{ now?: number }} options
 * @returns {object|null} the raw `giftCodes` row
 */
export function eligibleReferralGiftSync(db, giftCodeId, { now = Date.now() } = {}) {
  if (!db) throw new Error("eligibleReferralGiftSync requires the db adapter");
  if (!giftCodeId) return null;

  const row = db.get(`SELECT * FROM giftCodes WHERE id = ?`, [giftCodeId]);
  if (!row) return null;
  // A new-user code is the only kind a referral may advertise: the Telegram link
  // is what keeps referral signups from farming the gift (proposal "Welcome gift").
  if (Number(row.newUserOnly) !== 1) return null;
  if (Number(row.isActive) !== 1) return null;
  if (!inWindow(row, now)) return null;
  if (giftExhausted(row)) return null;
  return row;
}

/**
 * The gift code the referrer of `referrerUserId` advertises, or null.
 * Reads the referrer's effective gift id (override ?? default) first.
 */
export function referralGiftForSync(db, referrerUserId, { settings, now = Date.now() } = {}) {
  if (!referrerUserId) return null;
  // Nothing is advertised while the program is off or the referrer is blocked:
  // the gift belongs to an active referral link, like the link itself.
  if (settings?.affiliateEnabled !== true) return null;
  const affiliate = db.get(`SELECT * FROM affiliates WHERE userId = ?`, [referrerUserId]);
  if (!affiliate || affiliate.status !== "active") return null;
  const terms = effectiveTermsSync(affiliate, settings);
  return eligibleReferralGiftSync(db, terms.giftCodeId, { now });
}

/**
 * Whether `userId` already redeemed `giftId`. Shown codes are the ones the
 * account has not taken yet (spec: "and which has not redeemed that code yet").
 */
export function hasRedeemedGiftSync(db, userId, giftId) {
  if (!userId || !giftId) return false;
  const row = db.get(
    `SELECT 1 AS x FROM giftRedemptions WHERE userId = ? AND giftId = ? LIMIT 1`,
    [userId, giftId]
  );
  return Boolean(row);
}

/**
 * The welcome gift a referred account may still take, in the shape the gift page
 * and its API return: `{ id, code }` or null. `code` is the display form the
 * register banner shows, so both screens name the same code.
 */
export function referralGiftForBuyerSync(db, userId, { settings, now = Date.now() } = {}) {
  if (!userId) return null;
  const buyer = db.get(`SELECT id, referredByUserId FROM users WHERE id = ?`, [userId]);
  if (!buyer?.referredByUserId) return null;
  if (buyer.referredByUserId === buyer.id) return null;
  const row = referralGiftForSync(db, buyer.referredByUserId, { settings, now });
  if (!row) return null;
  if (hasRedeemedGiftSync(db, userId, row.id)) return null;
  return { id: row.id, code: row.code };
}
