import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getUserById } from "@/lib/localDb";
import { getAdminActor } from "@/lib/auth/adminIdentity";
import { getQueueSync, getPlanHistorySync } from "@/lib/db/repos/accountPlansRepo.js";
import { grantPlanSync, grantCreditSync } from "@/lib/billing/adminActions.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/users/[id]/plans — the customer's queue and plan history, rendered by
 * the SAME components as the customer's own page (design D19).
 */
export async function GET(request, { params }) {
  const { id } = await params;
  const user = await getUserById(id);
  if (!user) {
    return NextResponse.json({ error: "Không tìm thấy người dùng" }, { status: 404, headers: NO_STORE });
  }

  const db = await getAdapter();
  return NextResponse.json(
    { queue: getQueueSync(db, id), history: getPlanHistorySync(db, id) },
    { headers: NO_STORE }
  );
}

/**
 * POST /api/users/[id]/plans — grant a plan or grant credit.
 *
 * Body `{ type: "plan", planId, reason }` or
 *      `{ type: "credit", amountNanoUsd, durationDays, reason }`.
 *
 * One transaction: the purchase, its ledger row and its audit entry land together
 * or not at all.
 */
export async function POST(request, { params }) {
  const { id } = await params;
  const user = await getUserById(id);
  if (!user) {
    return NextResponse.json({ error: "Không tìm thấy người dùng" }, { status: 404, headers: NO_STORE });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400, headers: NO_STORE });
  }

  const actor = await getAdminActor(request);
  const db = await getAdapter();
  const type = String(body?.type || "plan");

  const result = db.transaction(() => {
    if (type === "credit") {
      return grantCreditSync(db, id, {
        amountNanoUsd: body?.amountNanoUsd,
        durationDays: body?.durationDays,
        reason: body?.reason,
        actor,
      });
    }
    return grantPlanSync(db, id, { planId: body?.planId, reason: body?.reason, actor });
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });
  }

  return NextResponse.json(
    { userPlan: result.userPlan, queue: getQueueSync(db, id) },
    { status: 201, headers: NO_STORE }
  );
}
