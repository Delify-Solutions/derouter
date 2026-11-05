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
 * program is enabled and the access mode admits the account (in invite-only
 * mode, only invited affiliates get a code and a link). With the program off, an account that already has wallet
 * history still sees its wallet and vouchers but gets no link (spec "Program
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

    // Terms, link and gift are shown only to an account that may refer: with the
    // program off, or an uninvited account in invite-only mode, nothing is advertised.
    const refer = overview.canRefer;
    let giftCode = null;
    if (refer && overview.giftCodeId) {
      const db = await getAdapter();
      const gift = eligibleReferralGiftSync(db, overview.giftCodeId);
      giftCode = gift ? gift.code : null;
    }

    let link = null;
    if (refer && overview.code) {
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
        // Invite-only mode: whether this account was invited, and whether it
        // may see the page at all (it keeps it while it has something to keep).
        inviteOnly: overview.inviteOnly,
        invited: overview.invited,
        canRefer: refer,
        available: overview.available,
        // With the program off there is no link to build, so the code is not
        // handed out either: the page shows the wallet and nothing else.
        code: refer ? overview.code : null,
        link,
        // With the program off the terms are not advertised: nothing accrues.
        rateBp: refer ? overview.rateBp : null,
        maxOrders: refer ? overview.maxOrders : null,
        giftCode,
        status: overview.status,
        stats: {
          clicks: overview.clicks,
          signups: overview.signups,
          payingReferrals: overview.payingReferrals,
        },
        buyerBonusBp: refer ? overview.buyerBonusBp : null,
        buyerBonusMaxOrders: refer ? overview.buyerBonusMaxOrders : null,
        wallet: overview.wallet,
        redeem: overview.redeem,
      },
      { headers: NO_STORE }
    );
  } catch {
    return NextResponse.json({ error: "Không tải được trang giới thiệu" }, { status: 500, headers: NO_STORE });
  }
}
