import { NextResponse } from "next/server";
import { getPlanById, updatePlan, deletePlan } from "@/lib/db/repos/billingRepo.js";
import { listPlanModelLimits } from "@/lib/db/repos/planLimitsRepo.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const plan = await getPlanById(id);
    if (!plan) return NextResponse.json({ error: "Plan not found" }, { status: 404, headers: NO_STORE });
    // Included here rather than behind a second call so the admin form loads a
    // plan and its per-model ceilings in one round trip.
    const modelLimits = await listPlanModelLimits(id);
    return NextResponse.json({ plan: { ...plan, modelLimits } }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Failed to load plan" }, { status: 500, headers: NO_STORE });
  }
}

export async function PATCH(request, { params }) {
  const { id } = await params;
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400, headers: NO_STORE });
  }

  try {
    const plan = await updatePlan(id, body || {});
    if (!plan) return NextResponse.json({ error: "Plan not found" }, { status: 404, headers: NO_STORE });
    return NextResponse.json({ plan }, { headers: NO_STORE });
  } catch (error) {
    const message = error?.message || "Failed to update plan";
    const status = /already exists/i.test(message) ? 409 : 400;
    return NextResponse.json({ error: message }, { status, headers: NO_STORE });
  }
}

/** Soft delete — orders and granted plans keep a valid reference. */
export async function DELETE(request, { params }) {
  const { id } = await params;
  try {
    const ok = await deletePlan(id);
    if (!ok) return NextResponse.json({ error: "Plan not found" }, { status: 404, headers: NO_STORE });
    return NextResponse.json({ success: true }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Failed to delete plan" }, { status: 500, headers: NO_STORE });
  }
}
