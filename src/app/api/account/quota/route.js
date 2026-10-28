import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { getAdapter } from "@/lib/db/driver.js";
import { getModelCostSinceNano } from "@/lib/db/repos/usageRepo.js";
import { listAllPlanModelLimits, PLAN_WINDOWS, windowLimitNano } from "@/lib/db/repos/planLimitsRepo.js";
import { fmtUsdNano } from "@/shared/utils/money.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/account/quota — what the customer may still use, per model.
 *
 * This is the number a subscription customer actually needs: their plan is a
 * per-model ceiling that refills on its own windows, so "how much is left on
 * Claude Haiku in the next 5 hours" is the question. The wallet figure is a
 * different thing (pay-as-you-go credit) and is not shown as the headline here.
 *
 * Ceilings across stacked plans are summed, matching enforcement.
 */
export async function GET(request) {
  const session = await resolveAccountUser(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }

  try {
    const db = await getAdapter();
    const now = new Date();
    const at = now.toISOString();

    const plans = db.all(
      `SELECT p.id, p.code, p.name, up.startsAt, up.expiresAt, up.orderId
         FROM userPlans up
         JOIN plans p ON p.id = up.planId
        WHERE up.userId = ?
          AND up.status = 'active'
          AND up.expiresAt > ?
          AND p.id IS NOT NULL
        ORDER BY up.startsAt ASC, up.createdAt ASC`,
      [session.userId, at]
    );

    if (!plans.length) {
      // No subscription: the account is on credit. Say so explicitly rather than
      // returning an empty quota list that looks like a broken page.
      return NextResponse.json(
        {
          mode: "credit",
          plans: [],
          models: [],
          windows: PLAN_WINDOWS.map((w) => ({ id: w.id, label: w.label, fraction: w.fraction })),
          note: "Tài khoản chưa có gói thuê bao. Lưu lượng được trừ vào credit.",
        },
        { headers: NO_STORE }
      );
    }

    const limitsByPlan = await listAllPlanModelLimits();

    // Merge ceilings across every active plan, exactly as enforcement does.
    const ceilings = new Map();
    for (const plan of plans) {
      for (const limit of limitsByPlan.get(plan.id) ?? []) {
        const existing = ceilings.get(limit.model);
        if (existing) existing.monthlyNanoUsd += limit.monthlyNanoUsd;
        else ceilings.set(limit.model, { model: limit.model, monthlyNanoUsd: limit.monthlyNanoUsd });
      }
    }

    // Spend per window, once, then attribute to each model.
    const spendByWindow = {};
    for (const w of PLAN_WINDOWS) {
      const since = new Date(now.getTime() - w.ms).toISOString();
      spendByWindow[w.id] = await getModelCostSinceNano(session.userId, since);
    }

    const models = [...ceilings.values()].map((entry) => {
      const windows = PLAN_WINDOWS.map((w) => {
        const cap = windowLimitNano(entry.monthlyNanoUsd, w.id);
        const spent = spendByWindow[w.id].get(entry.model) ?? 0;
        return {
          id: w.id,
          label: w.label,
          limitNanoUsd: cap,
          spentNanoUsd: spent,
          remainingNanoUsd: Math.max(0, cap - spent),
          limitUsd: fmtUsdNano(cap),
          spentUsd: fmtUsdNano(spent),
          remainingUsd: fmtUsdNano(Math.max(0, cap - spent)),
          resetAt: new Date(now.getTime() + w.ms).toISOString(),
        };
      });
      return {
        model: entry.model,
        monthlyNanoUsd: entry.monthlyNanoUsd,
        monthlyUsd: fmtUsdNano(entry.monthlyNanoUsd),
        windows,
      };
    });

    return NextResponse.json(
      {
        mode: "subscription",
        plans: plans.map((p) => ({
          id: p.id,
          code: p.code,
          name: p.name,
          startsAt: p.startsAt,
          expiresAt: p.expiresAt,
        })),
        models,
        windows: PLAN_WINDOWS.map((w) => ({ id: w.id, label: w.label, fraction: w.fraction })),
      },
      { headers: NO_STORE }
    );
  } catch (error) {
    console.error("[account/quota]", error?.message || error);
    return NextResponse.json({ error: "Không tải được hạn mức" }, { status: 500, headers: NO_STORE });
  }
}
