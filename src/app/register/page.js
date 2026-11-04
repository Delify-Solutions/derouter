import { Suspense } from "react";
import { cookies } from "next/headers";
import RegisterForm from "./components/RegisterForm";
import PromoPopupSlot from "@/app/landing/components/PromoPopupSlot";
import { getAdapter } from "@/lib/db/driver.js";
import { REF_COOKIE } from "@/lib/affiliate/constants.js";
import { resolveFirstReferralSync } from "@/lib/affiliate/core.js";
import { readAffiliateSettingsSync } from "@/lib/affiliate/settings.js";
import { referralGiftForSync } from "@/lib/affiliate/gift.js";
import { formatGiftCode } from "@/lib/db/repos/giftRepo.js";

export const dynamic = "force-dynamic";

/**
 * The referral a visitor arrived with, resolved on the server (design D6).
 *
 * Doing it here rather than through a public lookup API keeps codes from being
 * enumerable: an invalid one simply produces no banner, exactly like no code.
 * The referrer's identity is NOT passed on — the banner shows a code, never the
 * affiliate's email.
 *
 * @returns {Promise<{ code: string, giftCode: string|null }|null>}
 */
async function resolveReferral(refParam) {
  const cookieStore = await cookies();
  try {
    const db = await getAdapter();
    const settings = readAffiliateSettingsSync(db);
    // Same candidates, same order as POST /api/public/register: an invalid
    // `?ref=` falls through to a valid cookie, so the banner matches the binding.
    const referral = resolveFirstReferralSync(db, [refParam, cookieStore.get(REF_COOKIE)?.value], { settings });
    if (!referral) return null;
    const gift = referralGiftForSync(db, referral.referrerId, { settings });
    return { code: referral.code, giftCode: gift ? formatGiftCode(gift.code) : null };
  } catch {
    // A database blip must not take the signup page down: the visitor registers
    // without attribution, which is also what an invalid code does.
    return null;
  }
}

export default async function RegisterPage({ searchParams }) {
  // Reachable while signed in: signing up for a second account is a legitimate
  // action and does not require logging out first.
  //
  // The form reads `?next=` itself through useSearchParams, which is why the
  // Suspense boundary below is required during pre-rendering.
  const params = await searchParams;
  const refParam = typeof params?.ref === "string" ? params.ref : "";
  const referral = await resolveReferral(refParam);

  return (
    <Suspense fallback={<div className="h-40" />}>
      <RegisterForm referral={referral} />
      <PromoPopupSlot />
    </Suspense>
  );
}
