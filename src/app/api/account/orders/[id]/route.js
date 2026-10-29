import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { cancelOrder, getOrderById } from "@/lib/db/repos/billingRepo.js";
import { getAdapter } from "@/lib/db/driver.js";
import { buildPaymentBlock } from "@/lib/payments/orderPayment.js";
import { parseJson } from "@/lib/db/helpers/jsonCol.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/** The provider row a payment block needs: display name + public account fields. */
async function loadProvider(providerId) {
  if (!providerId) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT id, kind, name, config FROM paymentProviders WHERE id = ?`, [providerId]);
  if (!row) return null;
  // Only the non-secret config is used here; `secrets` is never selected.
  return { id: row.id, kind: row.kind, name: row.name, config: parseJson(row.config, {}) ?? {} };
}

/**
 * GET /api/account/orders/[id]
 *
 * Owner-only, and 404 for anyone else: a customer must not learn that an order id
 * exists (spec payment-checkout "Order page" — "someone else's order").
 *
 * The `payment` block is exactly what the page renders; a manual order has none.
 */
export async function GET(request, { params }) {
  const session = await resolveAccountUser(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });

  const { id } = await params;

  try {
    const order = await getOrderById(id);
    if (!order || order.userId !== session.userId) {
      return NextResponse.json({ error: "Order not found" }, { status: 404, headers: NO_STORE });
    }

    const provider = await loadProvider(order.paymentProviderId);
    return NextResponse.json(
      { order, payment: buildPaymentBlock({ order, provider }) },
      { headers: NO_STORE }
    );
  } catch {
    return NextResponse.json({ error: "Failed to load order" }, { status: 500, headers: NO_STORE });
  }
}

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
      { error: "Chỉ huỷ được đơn đang chờ thanh toán" },
      { status: 409, headers: NO_STORE }
    );
  } catch {
    return NextResponse.json({ error: "Failed to cancel order" }, { status: 500, headers: NO_STORE });
  }
}
