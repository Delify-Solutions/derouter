import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { createOrder, listOrders, getPlanById } from "@/lib/db/repos/billingRepo.js";
import { fmtUsdNano } from "@/shared/utils/money.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Announce a new order to the admin chat. Imported dynamically and fully wrapped:
 * the notification is a courtesy, so a missing bot token, a Telegram outage, or
 * the notify module being absent must never fail a request whose order row is
 * already written.
 */
async function notifyNewOrder(payload) {
  try {
    const mod = await import("@/lib/notify/telegram");
    if (typeof mod?.notifyAdminNewOrder === "function") {
      await mod.notifyAdminNewOrder(payload);
    }
  } catch (error) {
    console.warn("[account/orders] admin notification skipped:", error?.message || error);
  }
}

function decorate(order) {
  return {
    ...order,
    amountUsd: fmtUsdNano(order.amountNanoUsd),
    creditUsd: fmtUsdNano(order.creditNanoUsd),
  };
}

export async function GET(request) {
  const session = await resolveAccountUser(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });

  try {
    const { orders, total } = await listOrders({ userId: session.userId });
    return NextResponse.json({ orders: orders.map(decorate), total }, { headers: NO_STORE });
  } catch (error) {
    console.log("[account/orders] list failed:", error?.message || error);
    return NextResponse.json({ error: "Failed to load orders" }, { status: 500, headers: NO_STORE });
  }
}

/** Create a pending manual-transfer order. No gateway: an admin approves it. */
export async function POST(request) {
  const session = await resolveAccountUser(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400, headers: NO_STORE });
  }

  const planId = typeof body?.planId === "string" ? body.planId.trim() : "";
  if (!planId) return NextResponse.json({ error: "planId is required" }, { status: 400, headers: NO_STORE });

  const payerNote = typeof body?.payerNote === "string" && body.payerNote.trim()
    ? body.payerNote.trim().slice(0, 500)
    : null;

  try {
    const plan = await getPlanById(planId);
    if (!plan || !plan.isActive) {
      return NextResponse.json({ error: "Plan not available" }, { status: 404, headers: NO_STORE });
    }

    const order = await createOrder({ userId: session.userId, planId, payerNote });

    await notifyNewOrder({
      email: session.email,
      planName: plan.name || plan.code,
      amountNanoUsd: order.amountNanoUsd,
      status: order.status,
      method: order.method,
      orderId: order.id,
    });

    return NextResponse.json({ order: decorate(order) }, { status: 201, headers: NO_STORE });
  } catch (error) {
    const message = error?.message || "Failed to create order";
    const status = /not found|not available/i.test(message) ? 404 : 400;
    return NextResponse.json({ error: message }, { status, headers: NO_STORE });
  }
}
