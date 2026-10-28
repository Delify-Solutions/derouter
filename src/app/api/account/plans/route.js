import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { walletSummary, listPlans } from "@/lib/db/repos/billingRepo.js";
import { fmtUsdNano } from "@/shared/utils/money.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

function money(plan) {
  return {
    ...plan,
    priceUsd: fmtUsdNano(plan.priceNanoUsd),
    creditUsd: fmtUsdNano(plan.creditNanoUsd),
  };
}

/** The caller's own plans plus the plans they can buy. */
export async function GET(request) {
  const session = await resolveAccountUser(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });

  try {
    const [summary, plans] = await Promise.all([
      walletSummary(session.userId),
      listPlans({ onlyActive: true }),
    ]);

    return NextResponse.json(
      {
        availableNanoUsd: summary.availableNanoUsd,
        overdraftNanoUsd: summary.overdraftNanoUsd,
        myPlans: summary.plans.map((plan) => ({
          ...plan,
          creditTotalUsd: fmtUsdNano(plan.creditTotalNanoUsd),
          creditRemainingUsd: fmtUsdNano(plan.creditRemainingNanoUsd),
          creditUsedUsd: fmtUsdNano(plan.creditUsedNanoUsd),
        })),
        plans: plans.map(money),
      },
      { headers: NO_STORE }
    );
  } catch {
    return NextResponse.json({ error: "Failed to load plans" }, { status: 500, headers: NO_STORE });
  }
}
