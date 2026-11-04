import { cookies } from "next/headers";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { mergeLandingCopy } from "@/lib/db/repos/contentRepo.js";
import { getAdapter } from "@/lib/db/driver.js";
import { verifyUserToken, USER_COOKIE } from "@/lib/auth/userSession";
import { promoPopupState } from "@/shared/utils/promoPopup.js";
import { isNewAccountForPromoSync } from "@/lib/promo/newAccount.js";
import PromoPopup from "./PromoPopup";

/** Only the popup keys travel to the browser, not the whole landing copy. */
function popupCopy(copy) {
  const out = {};
  for (const key of Object.keys(copy)) if (key.startsWith("popup")) out[key] = copy[key];
  return out;
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
export default async function PromoPopupSlot({ accountUserId = null, signedIn = null, hideOn = [], copy: loadedCopy = null }) {
  let copy = loadedCopy;
  if (!copy) {
    try {
      copy = mergeLandingCopy((await getSettings()).landingCopy);
    } catch {
      return null; // a settings read error must never break the page around it
    }
  }
  if (promoPopupState(copy) !== "live") return null;

  let customer = signedIn;
  if (accountUserId) {
    try {
      const db = await getAdapter();
      if (!isNewAccountForPromoSync(db, accountUserId, copy.popupCode)) return null;
    } catch {
      return null;
    }
    customer = true;
  } else if (customer === null) {
    try {
      const token = (await cookies()).get(USER_COOKIE)?.value;
      customer = Boolean(token && (await verifyUserToken(token)));
    } catch {
      customer = false;
    }
  }

  return (
    <PromoPopup
      copy={popupCopy(copy)}
      signedIn={customer}
      hideOn={hideOn}
      // In the account area the audience changes while the layout stays mounted:
      // re-checked with the server before each opening.
      eligibilityUrl={accountUserId ? "/api/account/promo-popup" : null}
    />
  );
}
