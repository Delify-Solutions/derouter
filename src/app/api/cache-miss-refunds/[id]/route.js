import { NextResponse } from "next/server";
import { requirePagePermission } from "@/lib/auth/adminAccess";
import { approveCacheMissDetection, rejectCacheMissDetection } from "@/lib/billing/cacheMissRefund.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };
const ACTIONS = ["approve", "reject"];

/**
 * PATCH /api/cache-miss-refunds/:id { action: "approve"|"reject", adminNote? }
 *
 * Approve posts the refund ledger row immediately, independent of that user's
 * daily auto-refund cap. Reject marks the detection rejected, permanently — the
 * sweep never revisits it. Both only ever act on a `pending` row.
 */
export async function PATCH(request, { params }) {
  const denied = await requirePagePermission(request, "cache-refunds", "edit");
  if (denied) return denied;
  const { id } = await params;

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400, headers: NO_STORE });
  }

  const action = String(body?.action || "").toLowerCase();
  if (!ACTIONS.includes(action)) {
    return NextResponse.json({ error: `action must be one of ${ACTIONS.join(", ")}` }, { status: 400, headers: NO_STORE });
  }
  const adminNote = typeof body?.adminNote === "string" && body.adminNote.trim() ? body.adminNote.trim() : null;

  try {
    const result = action === "approve"
      ? await approveCacheMissDetection(id, { adminNote })
      : await rejectCacheMissDetection(id, { adminNote });

    if (!result.ok) {
      const message = result.error === "not_found"
        ? "Không tìm thấy mục này"
        : result.error === "not_pending"
          ? "Mục này đã được xử lý"
          : "Không tìm được gói để hoàn tiền vào";
      return NextResponse.json({ error: message }, { status: result.status || 409, headers: NO_STORE });
    }

    return NextResponse.json({ detection: result.detection }, { headers: NO_STORE });
  } catch (error) {
    console.error("[cache-miss-refunds] action failed:", error?.message || error);
    return NextResponse.json({ error: "Action failed" }, { status: 500, headers: NO_STORE });
  }
}
