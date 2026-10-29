import { NextResponse } from "next/server";
import { listOrders } from "@/lib/db/repos/billingRepo.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

// `expired` is a gateway order whose payment window closed unpaid. It is a
// terminal, non-paying state like `cancelled`: it never counts toward a purchase
// limit and it can only be revived by an admin assigning a late payment to it.
const STATUSES = ["pending", "paid", "cancelled", "expired", "refunded"];

export async function GET(request) {
  const status = request.nextUrl.searchParams.get("status");
  const userId = request.nextUrl.searchParams.get("userId");

  if (status && !STATUSES.includes(status)) {
    return NextResponse.json(
      { error: `status must be one of ${STATUSES.join(", ")}` },
      { status: 400, headers: NO_STORE }
    );
  }

  try {
    const { orders, total } = await listOrders({ status: status || null, userId: userId || null });
    return NextResponse.json({ orders, total }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Failed to load orders" }, { status: 500, headers: NO_STORE });
  }
}
