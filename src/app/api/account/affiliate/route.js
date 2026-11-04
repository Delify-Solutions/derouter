import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { resolveBaseUrl } from "@/lib/users/register";
import { getSettings } from "@/lib/localDb";
import { getAffiliateOverview, hasAffiliateHistory } from "@/lib/db/repos/affiliateRepo.js";
import { eligibleReferralGiftSync } from "@/lib/affiliate/gift.js";
import { getAdapter } from "@/lib/db/driver.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/account/affiliate — the customer page payload (design D8).
 *
 * Opening this page is what creates the account's code, and only while the
 * program is enabled. With the program off, an account that already has wallet
 * history still sees its wallet and withdrawals but gets no link (spec "Program
 * settings").
 */
export async function GET(request) {
  const session = await resolveAccountUser(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });

  try {
    const overview = await getAffiliateOverview(session.userId);
    // The same test the account layout uses for the nav item, so the page and
    // the menu never disagree about whether the account may see its wallet.
    const history = await hasAffiliateHistory(session.userId);

    // With the program off nothing is advertised, the welcome gift included.
    let giftCode = null;
    if (overview.enabled && overview.giftCodeId) {
      const db = await getAdapter();
      const gift = eligibleReferralGiftSync(db, overview.giftCodeId);
      giftCode = gift ? gift.code : null;
    }

    let link = null;
    if (overview.enabled && overview.code) {
      let settings = {};
      try {
        settings = await getSettings();
      } catch {
        settings = {};
      }
      const base = resolveBaseUrl(request, settings);
      link = base ? `${base}/r/${overview.code}` : null;
    }

    return NextResponse.json(
      {
        // A disabled program shows the wallet only.
        enabled: overview.enabled,
        hasHistory: history,
        // With the program off there is no link to build, so the code is not
        // handed out either: the page shows the wallet and nothing else.
        code: overview.enabled ? overview.code : null,
        link,
        // With the program off the terms are not advertised: nothing accrues.
        rateBp: overview.enabled ? overview.rateBp : null,
        maxOrders: overview.enabled ? overview.maxOrders : null,
        giftCode,
        status: overview.status,
        stats: {
          clicks: overview.clicks,
          signups: overview.signups,
          payingReferrals: overview.payingReferrals,
        },
        wallet: overview.wallet,
        payout: overview.payout,
        minWithdraw: overview.minWithdraw,
      },
      { headers: NO_STORE }
    );
  } catch {
    return NextResponse.json({ error: "Không tải được trang giới thiệu" }, { status: 500, headers: NO_STORE });
  }
}
