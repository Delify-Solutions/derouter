// Who still sees the promotional popup inside /account (spec promo-popup
// "Promotional popup"): an account that never bought a plan and has not
// redeemed the popup's own code. "Bought" means a purchase grant, the same
// notion the new-user gift codes use.
//
// SYNCHRONOUS + DRIVER-FREE: takes the adapter. Relative imports only.
import { normalizePromoCode } from "../../shared/utils/promoPopup.js";

export function isNewAccountForPromoSync(db, userId, code) {
  if (!userId) return false;
  const bought = db.get(
    `SELECT 1 AS x FROM userPlans WHERE userId = ? AND source = 'purchase' LIMIT 1`,
    [userId]
  );
  if (bought) return false;
  const key = normalizePromoCode(code);
  if (!key) return true;
  // Separator-agnostic, like giftRepo.findGiftRowByCode: older codes may be
  // stored with their dashes or spaces (WEL-COME), the popup key never has them.
  const redeemed = db.get(
    `SELECT 1 AS x FROM giftRedemptions r JOIN giftCodes g ON g.id = r.giftId
      WHERE r.userId = ? AND REPLACE(REPLACE(UPPER(g.code), '-', ''), ' ', '') = ? LIMIT 1`,
    [userId, key]
  );
  return !redeemed;
}
