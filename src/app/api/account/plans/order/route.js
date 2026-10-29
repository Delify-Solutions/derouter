import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { getAdapter } from "@/lib/db/driver.js";
import { reorderSync } from "@/lib/billing/planQueue.js";
import { getQueueSync } from "@/lib/db/repos/accountPlansRepo.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * PUT /api/account/plans/order — save the customer's queue order.
 *
 * Body `{ orderedIds }` must be EXACTLY the current queue. A stale list (a plan
 * expired or a grant landed since the page loaded) is answered 409 `queue_changed`
 * and changes nothing: applying a stale order would silently move spending between
 * pools the customer did not choose.
 *
 * 200 `{ queue }` — the fresh queue, so the page can render the saved order without
 * a second request. 400 `invalid_order` for an empty/duplicate/non-string list.
 */
export async function PUT(request) {
  const session = await resolveAccountUser(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "invalid_order", message: "Danh sách thứ tự không hợp lệ" } },
      { status: 400, headers: NO_STORE }
    );
  }

  try {
    const db = await getAdapter();
    const result = db.transaction(() =>
      reorderSync(db, session.userId, body?.orderedIds, { actor: "customer" })
    );

    if (!result.ok) {
      const message =
        result.code === "queue_changed"
          ? "Danh sách gói đã thay đổi — đã tải lại"
          : "Danh sách thứ tự không hợp lệ";
      return NextResponse.json({ error: { code: result.code, message } }, { status: result.status, headers: NO_STORE });
    }

    return NextResponse.json({ queue: getQueueSync(db, session.userId) }, { headers: NO_STORE });
  } catch (error) {
    console.error("[account/plans/order] failed:", error?.message || error);
    return NextResponse.json({ error: "Không lưu được thứ tự gói" }, { status: 500, headers: NO_STORE });
  }
}
