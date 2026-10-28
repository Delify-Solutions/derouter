import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { walletSummary, listPlans, planPurchaseBlocker } from "@/lib/db/repos/billingRepo.js";
import { getAdapter } from "@/lib/db/driver.js";
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
        // Every plan carries whether THIS user may buy it, and why not. Computing
        // it here means the pricing page can disable the button with a reason
        // instead of letting the customer click through to a bare 403.
        plans: await Promise.all(
          plans.map(async (plan) => {
            const db = await getAdapter();
            const blocker = await planPurchaseBlocker(
              db,
              plan,
              { id: session.userId, groupId: session.user?.groupId ?? null }
            );
            return {
              ...money(plan),
              purchasable: !blocker,
              blockedReason: blocker?.reason ?? null,
              blockedCode: blocker?.code ?? null,
            };
          })
        ),
      },
      { headers: NO_STORE }
    );
  } catch {
    return NextResponse.json({ error: "Failed to load plans" }, { status: 500, headers: NO_STORE });
  }
}
