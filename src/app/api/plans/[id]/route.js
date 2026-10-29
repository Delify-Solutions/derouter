import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getPlanById, updatePlanSync, deletePlan, validatePlanInput } from "@/lib/db/repos/billingRepo.js";
import { applyLimitsToActiveSync } from "@/lib/billing/adminActions.js";
import { getAdminActor } from "@/lib/auth/adminIdentity";
import { parseLimits } from "@/lib/billing/limits.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const plan = await getPlanById(id);
    if (!plan) return NextResponse.json({ error: "Plan not found" }, { status: 404, headers: NO_STORE });
    // `limits` is part of the plan object now; there is no per-model ceiling to
    // return — that surface is gone with the per-model table.
    return NextResponse.json({ plan }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Failed to load plan" }, { status: 500, headers: NO_STORE });
  }
}

/**
 * PATCH /api/plans/[id]
 *
 * Accepts `limits` (validated against this plan's credit and duration; 400 with a
 * Vietnamese message naming the offending limit) and, when the limits actually
 * changed, an optional `applyToActive: true` that also rewrites every ACTIVE
 * purchase of the plan.
 *
 * The template write and the apply-to-active pass share ONE transaction: a customer
 * must never sit on a plan whose template was saved but whose purchases were left
 * with the old rules because the second write failed.
 *
 * Response: `{ plan, affectedCount }` — `affectedCount` only when the pass ran.
 */
export async function PATCH(request, { params }) {
  const { id } = await params;
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400, headers: NO_STORE });
  }

  // applyToActive is a directive, not a plan column.
  const patch = { ...(body || {}) };
  delete patch.applyToActive;
  const applyToActive = body?.applyToActive === true;

  try {
    const current = await getPlanById(id);
    if (!current) return NextResponse.json({ error: "Plan not found" }, { status: 404, headers: NO_STORE });

    // Validate up front so a rejected limit writes nothing at all.
    const merged = { ...current, ...patch, limits: patch.limits ?? current.limits };
    const invalid = validatePlanInput(merged);
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400, headers: NO_STORE });

    const limitsChanged =
      JSON.stringify(parseLimits(merged.limits)) !== JSON.stringify(parseLimits(current.limits));
    const shouldApply = applyToActive && limitsChanged;
    const actor = shouldApply ? await getAdminActor(request) : null;

    const db = await getAdapter();
    const outcome = db.transaction(() => {
      const next = updatePlanSync(db, id, patch);
      if (!next) return { missing: true };

      let affectedCount = null;
      if (shouldApply) {
        const applied = applyLimitsToActiveSync(db, id, parseLimits(next.limits), {
          actor,
          planCode: next.code,
        });
        if (applied?.ok === false) return { failed: applied };
        affectedCount = applied.affectedCount;
      }
      return { plan: next, affectedCount };
    });

    if (outcome.missing) {
      return NextResponse.json({ error: "Plan not found" }, { status: 404, headers: NO_STORE });
    }
    if (outcome.failed) {
      return NextResponse.json(
        { error: outcome.failed.error },
        { status: outcome.failed.status || 400, headers: NO_STORE }
      );
    }
    if (outcome.affectedCount == null) {
      return NextResponse.json({ plan: outcome.plan }, { headers: NO_STORE });
    }
    return NextResponse.json({ plan: outcome.plan, affectedCount: outcome.affectedCount }, { headers: NO_STORE });
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
