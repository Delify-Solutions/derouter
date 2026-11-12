// Who still counts as a NEW account for the promotional popup (spec promo-popup
// "Promotional popup"): an account that has never received any plan or
// credit — bought, granted by an admin, from a gift code, affiliate credit or a
// referral bonus — and has never redeemed a gift code. Owner decision: an old
// account that only ever used admin-granted or gifted plans is not new.
//
// The popup code is no longer consulted on its own: redeeming it (or any code)
// already makes the account not new.
//
// SYNCHRONOUS + DRIVER-FREE: takes the adapter. Relative imports only.

export function isNewAccountForPromoSync(db, userId, _code = null) {
  if (!userId) return false;
  const anyPlan = db.get(`SELECT 1 AS x FROM userPlans WHERE userId = ? LIMIT 1`, [userId]);
  if (anyPlan) return false;
  const anyGift = db.get(`SELECT 1 AS x FROM giftRedemptions WHERE userId = ? LIMIT 1`, [userId]);
  return !anyGift;
}
