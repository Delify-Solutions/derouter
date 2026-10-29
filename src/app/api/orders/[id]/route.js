import { NextResponse } from "next/server";
import { getOrderById, approveOrder, refundOrder, updateOrderStatus } from "@/lib/db/repos/billingRepo.js";
import { getAdminIdentity } from "@/lib/auth/adminIdentity";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

// Actions an admin can take. `cancel` here is the admin path (any pending order);
// the owner-facing cancel lives on /api/account/orders/:id.
const ACTIONS = ["approve", "cancel", "refund"];

// `approvedBy` stores the raw identity (no "admin:" prefix): it has always been a
// display value on the order row, and the audit prefix belongs to the audit log.
const currentAdminId = getAdminIdentity;

export async function GET(request, { params }) {
  const { id } = await params;
  try {
    const order = await getOrderById(id);
    if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404, headers: NO_STORE });
    return NextResponse.json({ order }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Failed to load order" }, { status: 500, headers: NO_STORE });
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

  const action = String(body?.action || "").toLowerCase();
  if (!ACTIONS.includes(action)) {
    return NextResponse.json(
      { error: `action must be one of ${ACTIONS.join(", ")}` },
      { status: 400, headers: NO_STORE }
    );
  }
  const adminNote = typeof body?.adminNote === "string" && body.adminNote.trim()
    ? body.adminNote.trim()
    : null;

  try {
    if (action === "approve") {
      const result = await approveOrder(id, await currentAdminId(request));
      if (!result) return NextResponse.json({ error: "Order not found" }, { status: 404, headers: NO_STORE });
      if (result.alreadyApproved) {
        return NextResponse.json({ order: result.order, alreadyApproved: true }, { headers: NO_STORE });
      }
      if (adminNote) await updateOrderStatus(id, { status: result.order.status, adminNote });
      return NextResponse.json(
        {
          order: adminNote ? await getOrderById(id) : result.order,
          userPlan: result.userPlan,
          appliedToOverdraftNanoUsd: result.appliedToOverdraftNanoUsd,
        },
        { headers: NO_STORE }
      );
    }

    if (action === "refund") {
      const result = await refundOrder(id, { adminId: await currentAdminId(request), adminNote });
      if (!result) return NextResponse.json({ error: "Order not found" }, { status: 404, headers: NO_STORE });
      return NextResponse.json(
        {
          order: result.order,
          userPlan: result.userPlan,
          refundedNanoUsd: result.refundedNanoUsd,
          alreadyRefunded: result.alreadyRefunded,
        },
        { headers: NO_STORE }
      );
    }

    // action === "cancel"
    const order = await getOrderById(id);
    if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404, headers: NO_STORE });
    if (order.status !== "pending") {
      return NextResponse.json(
        { error: `Cannot cancel an order in status "${order.status}"` },
        { status: 409, headers: NO_STORE }
      );
    }
    const updated = await updateOrderStatus(id, { status: "cancelled", adminNote });
    return NextResponse.json({ order: updated }, { headers: NO_STORE });
  } catch (error) {
    const message = error?.message || "Action failed";
    return NextResponse.json({ error: message }, { status: 409, headers: NO_STORE });
  }
}
