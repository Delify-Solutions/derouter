import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { getAdapter } from "@/lib/db/driver.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { mergeLandingCopy } from "@/lib/db/repos/contentRepo.js";
import { isNewAccountForPromoSync } from "@/lib/promo/newAccount.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/account/promo-popup — may the promotional popup still open for this
 * account right now (spec promo-popup "Promotional popup": new accounts only)?
 *
 * The account layout stays mounted while the customer moves between pages, so
 * the eligibility it rendered with goes stale the moment they redeem the code or
 * buy a plan. The popup asks here each time it is about to open instead.
 */
export async function GET(request) {
  const session = await resolveAccountUser(request);
  if (!session) return NextResponse.json({ eligible: false }, { status: 401, headers: NO_STORE });
  try {
    const copy = mergeLandingCopy((await getSettings()).landingCopy);
    const db = await getAdapter();
    return NextResponse.json(
      { eligible: isNewAccountForPromoSync(db, session.userId, copy.popupCode) },
      { headers: NO_STORE }
    );
  } catch {
    return NextResponse.json({ eligible: false }, { headers: NO_STORE });
  }
}
