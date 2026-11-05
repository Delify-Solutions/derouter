import { cookies } from "next/headers";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { mergeLandingCopy } from "@/lib/db/repos/contentRepo.js";
import { getAdapter } from "@/lib/db/driver.js";
import { verifyUserToken, USER_COOKIE } from "@/lib/auth/userSession";
import { promoPopupState } from "@/shared/utils/promoPopup.js";
import { isNewAccountForPromoSync } from "@/lib/promo/newAccount.js";
import { REF_COOKIE } from "@/lib/affiliate/constants.js";
import { resolveFirstReferralSync } from "@/lib/affiliate/core.js";
import { readAffiliateSettingsSync } from "@/lib/affiliate/settings.js";
import { referralGiftForSync } from "@/lib/affiliate/gift.js";
import { buyerBonusTermsForReferrerSync } from "@/lib/affiliate/buyerBonus.js";
import { formatGiftCode } from "@/lib/db/repos/giftRepo.js";
import PromoPopup from "./PromoPopup";

/** Only the popup keys travel to the browser, not the whole landing copy. */
function popupCopy(copy) {
  const out = {};
  for (const key of Object.keys(copy)) if (key.startsWith("popup")) out[key] = copy[key];
  return out;
}

/**
 * The referral a visitor arrived with (the `dr_ref` cookie set by /r/<CODE>),
 * with what it gives them, or null. Read on the server so a code is never
 * looked up from the browser.
 */
async function visitorReferral(cookieStore) {
  const raw = cookieStore.get(REF_COOKIE)?.value;
  if (!raw) return null;
  const db = await getAdapter();
  const settings = readAffiliateSettingsSync(db);
  const referral = resolveFirstReferralSync(db, [raw], { settings });
  if (!referral) return null;
  const bonus = buyerBonusTermsForReferrerSync(db, referral.referrerId, settings);
  const gift = referralGiftForSync(db, referral.referrerId, { settings });
  // Nothing to offer the visitor (no buyer bonus, no welcome gift): no announcement.
  if (!(Number(bonus?.bp) > 0) && !gift) return null;
  return {
    code: referral.code,
    bonus: bonus ? { bp: bonus.bp, maxOrders: bonus.maxOrders } : null,
    giftCode: gift ? formatGiftCode(gift.code) : null,
  };
}

/**
 * The promotional popup for one place (spec promo-popup "Promotional popup").
 * Server component: reads the saved popup, renders nothing when it is off.
 *
 * - `accountUserId`: inside /account — shown only while the account is new.
 * - otherwise (landing, /register, /docs): shown to everyone; `signedIn` is
 *   worked out from the customer cookie when not given, so the button leads a
 *   signed-in customer straight to the gift page.
 */
export default async function PromoPopupSlot({ accountUserId = null, signedIn = null, hideOn = [], copy: loadedCopy = null, withReferral = true }) {
  let copy = loadedCopy;
  if (!copy) {
    try {
      copy = mergeLandingCopy((await getSettings()).landingCopy);
    } catch {
      return null; // a settings read error must never break the page around it
    }
  }
  const promoLive = promoPopupState(copy) === "live";

  let customer = signedIn;
  let referral = null;
  if (accountUserId) {
    if (!promoLive) return null;
    try {
      const db = await getAdapter();
      if (!isNewAccountForPromoSync(db, accountUserId, copy.popupCode)) return null;
    } catch {
      return null;
    }
    customer = true;
  } else {
    let cookieStore = null;
    try { cookieStore = await cookies(); } catch { cookieStore = null; }
    if (customer === null) {
      try {
        const token = cookieStore?.get(USER_COOKIE)?.value;
        customer = Boolean(token && (await verifyUserToken(token)));
      } catch {
        customer = false;
      }
    }
    // A referral only means something before sign-up: an existing account is
    // never attributed by a link (spec affiliate-program).
    if (withReferral && !customer && cookieStore) {
      try { referral = await visitorReferral(cookieStore); } catch { referral = null; }
    }
  }
  if (!promoLive && !referral) return null;

  return (
    <PromoPopup
      copy={popupCopy(copy)}
      signedIn={customer}
      referral={referral}
      hideOn={hideOn}
      // In the account area the audience changes while the layout stays mounted:
      // re-checked with the server before each opening.
      eligibilityUrl={accountUserId ? "/api/account/promo-popup" : null}
    />
  );
}
