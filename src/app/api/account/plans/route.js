import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { getAdapter } from "@/lib/db/driver.js";
import { listPlans, planPurchaseBlocker, getAvailableNanoUsd } from "@/lib/db/repos/billingRepo.js";
import { getQueueSync, getPlanHistorySync, toCatalogPlan } from "@/lib/db/repos/accountPlansRepo.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { offeredMethodsSync } from "@/lib/payments/checkout.js";
import { getDebtNanoSync } from "@/lib/billing/ledger.js";
import { payingRatesSync } from "@/lib/billing/rates.js";
import { getUserRateUsage } from "@/lib/db/repos/usageRepo.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/account/plans — everything the "Gói của tôi" page renders (design D18).
 *
 * `{ availableNanoUsd, debtNanoUsd, queue, history, plans }`
 *
 * The queue comes from queueViewSync, so each entry already carries the status
 * label ("paying" for the plan admission would pick, "blocked" with a reopen time,
 * "waiting" otherwise) and the per-limit window state. The page renders those
 * numbers; it never computes eligibility itself.
 */
export async function GET(request) {
  const session = await resolveAccountUser(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });

  try {
    const db = await getAdapter();
    const queue = getQueueSync(db, session.userId);
    // The allowance is per (user, plan): count the paying plan's own usage.
    const rates = payingRatesSync(db, session.userId);
    const [plans, availableNanoUsd, used] = await Promise.all([
      listPlans({ onlyActive: true }),
      getAvailableNanoUsd(session.userId),
      rates.rateKey ? getUserRateUsage(session.userId, 60_000, rates.rateKey) : { requests: 0, tokens: 0 },
    ]);

    // Buyability is decided in one place (planPurchaseBlocker) so the catalogue,
    // the checkout button and createOrder cannot disagree. Computed per plan
    // against THIS user, and returned as a reason the card can show.
    const groupId = session.user?.groupId ?? null;
    const settings = await getSettings();
    const catalogue = await Promise.all(
      plans.map(async (plan) => {
        const blocker = await planPurchaseBlocker(db, plan, { id: session.userId, groupId });
        // The buttons on the card ARE this list: a method appears only when the
        // plan prices it AND an active receiving account exists, which is the same
        // check POST /api/account/orders applies.
        const methods = offeredMethodsSync(db, plan, settings);
        return toCatalogPlan(plan, blocker, methods);
      })
    );

    return NextResponse.json(
      {
        availableNanoUsd,
        debtNanoUsd: getDebtNanoSync(db, session.userId),
        // An unlimited plan adds no credit to the sum above, so the page needs to
        // know one is live to say "Không giới hạn" instead of a misleading "$0".
        hasUnlimitedCredit: queue.some((entry) => entry.unlimitedCredit && entry.statusLabel !== "scheduled"),
        queue,
        // The RPM/TPM applied right now: the paying plan's, counted over every key
        // of the account in the last 60 seconds — the same numbers enforcement uses.
        rate: { ...rates, requests: used.requests, tokens: used.tokens },
        history: getPlanHistorySync(db, session.userId),
        plans: catalogue,
      },
      { headers: NO_STORE }
    );
  } catch (error) {
    console.error("[account/plans] failed:", error?.message || error);
    return NextResponse.json({ error: "Không tải được danh sách gói" }, { status: 500, headers: NO_STORE });
  }
}
