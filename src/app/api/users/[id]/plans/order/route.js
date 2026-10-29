import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getUserById } from "@/lib/localDb";
import { getAdminActor } from "@/lib/auth/adminIdentity";
import { getQueueSync } from "@/lib/db/repos/accountPlansRepo.js";
import { reorderSync } from "@/lib/billing/planQueue.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * PUT /api/users/[id]/plans/order — an admin reordering a customer's queue.
 *
 * Same rules as the customer's own reorder (the full current queue, or 409
 * `queue_changed`); the audit entry records the admin as the actor, which is the
 * difference that matters when a customer later asks who moved their plans.
 *
 * No reason is required: the audit row carries the before/after order, and a reorder
 * moves no money.
 */
export async function PUT(request, { params }) {
  const { id } = await params;
  const user = await getUserById(id);
  if (!user) {
    return NextResponse.json({ error: "Không tìm thấy người dùng" }, { status: 404, headers: NO_STORE });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "invalid_order", message: "Danh sách thứ tự không hợp lệ" } },
      { status: 400, headers: NO_STORE }
    );
  }

  const actor = await getAdminActor(request);
  const db = await getAdapter();
  const result = db.transaction(() => reorderSync(db, id, body?.orderedIds, { actor }));

  if (!result.ok) {
    const message = result.code === "queue_changed"
      ? "Danh sách gói đã thay đổi — đã tải lại"
      : "Danh sách thứ tự không hợp lệ";
    return NextResponse.json({ error: { code: result.code, message } }, { status: result.status, headers: NO_STORE });
  }

  return NextResponse.json({ queue: getQueueSync(db, id) }, { headers: NO_STORE });
}
