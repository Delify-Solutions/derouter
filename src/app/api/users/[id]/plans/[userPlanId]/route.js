import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getUserById } from "@/lib/localDb";
import { getAdminActor } from "@/lib/auth/adminIdentity";
import { getQueueSync } from "@/lib/db/repos/accountPlansRepo.js";
import {
  extendPlanSync,
  adjustCreditSync,
  setPurchaseLimitsSync,
  revokePlanSync,
} from "@/lib/billing/adminActions.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * PATCH /api/users/[id]/plans/[userPlanId] — edit one purchase.
 *
 * Body `{ action: "extend", days? | expiresAt?, reason }`
 *    | `{ action: "adjust", deltaNanoUsd, reason }`
 *    | `{ action: "limits", limits, reason }`
 *    | `{ action: "revoke", reason }`
 *
 * The purchase must belong to this user (the repo scopes every query by userId), so
 * a userPlanId from another account is a 404 rather than a cross-account edit.
 */
export async function PATCH(request, { params }) {
  const { id, userPlanId } = await params;
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
  const action = String(body?.action || "");

  const result = db.transaction(() => {
    switch (action) {
      case "extend":
        return extendPlanSync(db, id, userPlanId, {
          days: body?.days,
          expiresAt: body?.expiresAt,
          reason: body?.reason,
          actor,
        });
      case "adjust":
        return adjustCreditSync(db, id, userPlanId, {
          deltaNanoUsd: body?.deltaNanoUsd,
          reason: body?.reason,
          actor,
        });
      case "limits":
        return setPurchaseLimitsSync(db, id, userPlanId, {
          limits: body?.limits,
          reason: body?.reason,
          actor,
        });
      case "revoke":
        return revokePlanSync(db, id, userPlanId, { reason: body?.reason, actor });
      default:
        return { ok: false, status: 400, error: "Thao tác không hợp lệ" };
    }
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });
  }

  return NextResponse.json({ ...result, queue: getQueueSync(db, id) }, { headers: NO_STORE });
}
