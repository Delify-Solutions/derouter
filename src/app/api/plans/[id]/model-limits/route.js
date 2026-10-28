import { NextResponse } from "next/server";
import { getPlanById } from "@/lib/db/repos/billingRepo.js";
import {
  listPlanModelLimits,
  setPlanModelLimits,
  PLAN_WINDOWS,
  windowLimitNano,
} from "@/lib/db/repos/planLimitsRepo.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/plans/[id]/model-limits
 *
 * Returns the per-model ceilings plus the derived 5h/week/month figures, so the
 * admin UI never has to re-implement the 20/50/100% rule and cannot display a
 * window that disagrees with what enforcement uses.
 */
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const plan = await getPlanById(id);
    if (!plan) {
      return NextResponse.json({ error: "Không tìm thấy gói" }, { status: 404, headers: NO_STORE });
    }
    const limits = await listPlanModelLimits(id);
    return NextResponse.json(
      {
        planId: id,
        windows: PLAN_WINDOWS.map((w) => ({ id: w.id, label: w.label, fraction: w.fraction })),
        limits: limits.map((l) => ({
          ...l,
          windows: Object.fromEntries(
            PLAN_WINDOWS.map((w) => [w.id, windowLimitNano(l.monthlyNanoUsd, w.id)])
          ),
        })),
      },
      { headers: NO_STORE }
    );
  } catch {
    return NextResponse.json({ error: "Không tải được hạn mức" }, { status: 500, headers: NO_STORE });
  }
}

/**
 * PUT /api/plans/[id]/model-limits
 *
 * Body: { limits: [{ model, monthlyNanoUsd }] }
 *
 * Replaces the whole set. Partial upsert would leave deleted models metering
 * traffic the admin believes they removed.
 */
export async function PUT(request, { params }) {
  const { id } = await params;

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400, headers: NO_STORE });
  }
  if (!Array.isArray(body?.limits)) {
    return NextResponse.json({ error: "Thiếu danh sách limits" }, { status: 400, headers: NO_STORE });
  }
  // An empty list is meaningful: it removes every per-model ceiling and puts the
  // plan back on its flat credit. Only a missing array is an error.

  const plan = await getPlanById(id);
  if (!plan) {
    return NextResponse.json({ error: "Không tìm thấy gói" }, { status: 404, headers: NO_STORE });
  }

  try {
    const limits = await setPlanModelLimits(id, body.limits);
    return NextResponse.json({ planId: id, limits }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || "Không lưu được hạn mức" },
      { status: 400, headers: NO_STORE }
    );
  }
}
