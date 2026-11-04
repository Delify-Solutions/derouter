import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { getAdapter } from "@/lib/db/driver.js";
import { readAffiliateSettingsSync } from "@/lib/affiliate/settings.js";
import { referralGiftForBuyerSync } from "@/lib/affiliate/gift.js";
import { formatGiftCode } from "@/lib/db/repos/giftRepo.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/account/affiliate/gift — the welcome gift this account was referred
 * with, for the gift page (design D7).
 *
 * Returns `{ code: null }` for an account with no referrer, one whose referral
 * advertises no usable code, or one that already redeemed it. The redemption
 * rules themselves are untouched: this route only says what to prefill.
 */
export async function GET(request) {
  const session = await resolveAccountUser(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });

  try {
    const db = await getAdapter();
    const settings = readAffiliateSettingsSync(db);
    const gift = referralGiftForBuyerSync(db, session.userId, { settings });
    return NextResponse.json({ code: gift ? formatGiftCode(gift.code) : null }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ code: null }, { headers: NO_STORE });
  }
}
