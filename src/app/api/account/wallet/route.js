import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { walletSummary, getLedger } from "@/lib/db/repos/billingRepo.js";
import { fmtUsdNano } from "@/shared/utils/money.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
}

/** The caller's wallet: headline balance, every plan, overdraft and recent ledger. */
export async function GET(request) {
  const session = await resolveAccountUser(request);
  if (!session) return unauthorized();

  try {
    const limitParam = Number(request.nextUrl.searchParams.get("limit"));
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 25;

    const [summary, ledger] = await Promise.all([
      walletSummary(session.userId),
      getLedger(session.userId, { limit }),
    ]);

    return NextResponse.json(
      {
        availableNanoUsd: summary.availableNanoUsd,
        availableUsd: fmtUsdNano(summary.availableNanoUsd),
        hasUnlimitedCredit: summary.hasUnlimitedCredit === true,
        liveCreditNanoUsd: summary.liveCreditNanoUsd,
        liveCreditUsd: fmtUsdNano(summary.liveCreditNanoUsd),
        overdraftNanoUsd: summary.overdraftNanoUsd,
        overdraftUsd: fmtUsdNano(summary.overdraftNanoUsd),
        totalGrantedNanoUsd: summary.totalGrantedNanoUsd,
        totalGrantedUsd: fmtUsdNano(summary.totalGrantedNanoUsd),
        plans: summary.plans.map((plan) => ({
          ...plan,
          creditTotalUsd: fmtUsdNano(plan.creditTotalNanoUsd),
          creditRemainingUsd: fmtUsdNano(plan.creditRemainingNanoUsd),
          creditUsedUsd: fmtUsdNano(plan.creditUsedNanoUsd),
        })),
        ledger: ledger.entries,
        ledgerTotal: ledger.total,
      },
      { headers: NO_STORE }
    );
  } catch {
    return NextResponse.json({ error: "Failed to load wallet" }, { status: 500, headers: NO_STORE });
  }
}
