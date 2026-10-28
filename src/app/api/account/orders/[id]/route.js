import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { cancelOrder } from "@/lib/db/repos/billingRepo.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/** Owner-only cancellation of a still-pending order. */
export async function DELETE(request, { params }) {
  const session = await resolveAccountUser(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });

  const { id } = await params;

  try {
    const result = await cancelOrder(id, session.userId);
    if (result.ok) return NextResponse.json({ success: true, order: result.order }, { headers: NO_STORE });

    // 404 for someone else's order too: a customer must not learn that an id exists.
    if (result.reason === "not_found" || result.reason === "forbidden") {
      return NextResponse.json({ error: "Order not found" }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json(
      { error: "Only pending orders can be cancelled" },
      { status: 409, headers: NO_STORE }
    );
  } catch (error) {
    console.log("[account/orders/:id] cancel failed:", error?.message || error);
    return NextResponse.json({ error: "Failed to cancel order" }, { status: 500, headers: NO_STORE });
  }
}
