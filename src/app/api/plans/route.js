import { NextResponse } from "next/server";
import { listPlans, createPlan, validatePlanInput, planStats } from "@/lib/db/repos/billingRepo.js";
import { getKeyGroups } from "@/lib/db/repos/keyGroupsRepo.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Admin plan list. `?active=1` narrows to purchasable plans.
 *
 * Every plan carries `limits` (its per-window spending rules) and a `stats` block —
 * active purchases, distinct active users, revenue from paid orders and credit
 * consumed. The figures come from three grouped queries for the whole list, not one
 * query per plan.
 */
export async function GET(request) {
  try {
    const onlyActive = request.nextUrl.searchParams.get("active") === "1";
    const [plans, stats] = await Promise.all([listPlans({ onlyActive }), planStats()]);
    // Groups are returned alongside so the admin form can render the
    // "restricted to" picker without a second request.
    let groups = [];
    try {
      groups = await getKeyGroups();
    } catch {
      // No groups table yet — the picker just has nothing to offer.
    }
    const withStats = plans.map((plan) => ({
      ...plan,
      stats: stats.get(plan.id) ?? {
        activeCount: 0,
        activeUsers: 0,
        revenueVnd: 0,
        revenueUsdNano: 0,
        revenueNanoUsd: 0,
        consumedNanoUsd: 0,
      },
    }));
    return NextResponse.json({ plans: withStats, groups }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Failed to load plans" }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400, headers: NO_STORE });
  }

  // Same rules the admin form applies, so a hand-rolled request cannot create a
  // plan the UI would reject (and vice versa). Includes the limits validation,
  // which returns its Vietnamese message naming the offending limit.
  const invalid = validatePlanInput(body);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400, headers: NO_STORE });

  try {
    const plan = await createPlan(body);
    return NextResponse.json({ plan }, { status: 201, headers: NO_STORE });
  } catch (error) {
    const message = error?.message || "Failed to create plan";
    const status = /already exists/i.test(message) ? 409 : 400;
    return NextResponse.json({ error: message }, { status, headers: NO_STORE });
  }
}
