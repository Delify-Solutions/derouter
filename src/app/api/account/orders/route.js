import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { getAdapter } from "@/lib/db/driver.js";
import { createOrder, getOrderById, getPlanById, listOrders, planPurchaseBlocker } from "@/lib/db/repos/billingRepo.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { createGatewayOrderSync, offeredMethodsSync, MAX_PENDING_GATEWAY_ORDERS } from "@/lib/payments/checkout.js";
import { toCustomerOrder } from "@/lib/billing/orders.js";
import { fmtUsdNano, fmtCreditNano } from "@/shared/utils/money.js";
import { termLabel } from "@/lib/billing/terms.js";
import { recordActivity } from "@/lib/db/repos/activityRepo.js";

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
  // Customer-facing: only the whitelisted fields (see `toCustomerOrder`).
  const visible = toCustomerOrder(order);
  return {
    ...visible,
    amountUsd: fmtUsdNano(visible.amountNanoUsd),
    creditUsd: fmtCreditNano(visible.creditNanoUsd, visible.unlimitedCredit),
    // "3 tháng" — credit and duration above are per period (spec plan-terms).
    termText: termLabel(visible.durationDays, visible.periods),
  };
}

export async function GET(request) {
  const session = await resolveAccountUser(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });

  try {
    const { orders, total } = await listOrders({ userId: session.userId });
    return NextResponse.json({ orders: orders.map(decorate), total }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Failed to load orders" }, { status: 500, headers: NO_STORE });
  }
}

/**
 * Create a pending order for `{ planId, method }` (spec payment-checkout
 * "Creating a gateway order").
 *
 * Three paths, one entry point:
 *   `vietqr` / `binance` → `createGatewayOrderSync` (code, amount, provider, expiry)
 *   `manual`             → the existing approval-by-hand path, kept as the fallback
 *                          behind the `allowManualOrders` setting
 *
 * The method must be OFFERED for this plan, which is the same `offeredMethodsSync`
 * the purchase cards render — so a card cannot show a button this route refuses.
 */
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

  // Defaulting to `manual` keeps every pre-existing client working unchanged.
  const method = typeof body?.method === "string" && body.method.trim() ? body.method.trim() : "manual";
  if (!["vietqr", "binance", "manual"].includes(method)) {
    return NextResponse.json({ error: "Phương thức thanh toán không hợp lệ" }, { status: 400, headers: NO_STORE });
  }

  // Only a custom-amount plan takes an amount; the engine refuses it for any other
  // and checks the bounds, this only separates "not sent" from "sent".
  const hasAmount = body?.amountVnd !== undefined && body?.amountVnd !== null && body?.amountVnd !== "";
  const amountVnd = hasAmount ? body.amountVnd : null;

  // Number of back-to-back periods (spec plan-terms). Absent = one, as before.
  const hasPeriods = body?.periods !== undefined && body?.periods !== null && body?.periods !== "";
  const periods = hasPeriods ? Number(body.periods) : 1;
  if (!Number.isInteger(periods) || periods < 1) {
    return NextResponse.json({ error: "Kỳ hạn không hợp lệ" }, { status: 400, headers: NO_STORE });
  }

  // Affiliate voucher (spec affiliate-program "Voucher at checkout"). Optional.
  const voucherCode = typeof body?.voucherCode === "string" && body.voucherCode.trim()
    ? body.voucherCode.trim().slice(0, 64)
    : null;

  const payerNote = typeof body?.payerNote === "string" && body.payerNote.trim()
    ? body.payerNote.trim().slice(0, 500)
    : null;

  try {
    const plan = await getPlanById(planId);
    if (!plan || !plan.isActive) {
      return NextResponse.json({ error: "Plan not available" }, { status: 404, headers: NO_STORE });
    }

    const db = await getAdapter();
    const settings = await getSettings();

    // Buyability is decided in one place so the catalogue, the checkout button and
    // this call cannot disagree.
    const user = db.get(`SELECT id, email, groupId FROM users WHERE id = ?`, [session.userId]);
    const blocker = await planPurchaseBlocker(db, plan, user);
    if (blocker) {
      return NextResponse.json({ error: blocker.reason }, { status: 400, headers: NO_STORE });
    }

    const offered = offeredMethodsSync(db, plan, settings);
    if (!offered.some((entry) => entry.method === method)) {
      const reason = method === "manual"
        ? "Đơn thủ công đang tắt — chọn chuyển khoản hoặc Binance"
        : method === "vietqr"
          ? "Gói này chưa mở bán bằng chuyển khoản VietQR"
          : "Gói này chưa mở bán bằng Binance USDT";
      return NextResponse.json({ error: reason }, { status: 400, headers: NO_STORE });
    }

    if (method === "manual") {
      // createOrder records what the customer was quoted (payCurrency USD,
      // payAmount after any voucher / referral discount) in the same columns a
      // gateway order uses, so a single order list can show both.
      const order = await createOrder({ userId: session.userId, planId, payerNote, method: "manual", amountVnd, periods, voucherCode });
      const updated = await getOrderById(order.id);
      await recordActivity(request, {
        userId: session.userId,
        action: "order_create",
        details: { orderId: order.id, planId, method: "manual" },
      });
      await notifyNewOrder({
        email: session.email,
        planName: plan.name || plan.code,
        amountNanoUsd: order.amountNanoUsd,
        status: order.status,
        method: "manual",
        orderId: order.id,
      });
      return NextResponse.json(
        { order: decorate(updated), url: `/account/orders/${order.id}` },
        { status: 201, headers: NO_STORE }
      );
    }

    const created = db.transaction(() => createGatewayOrderSync(db, {
      userId: session.userId,
      plan,
      method,
      settings,
      amountVnd,
      periods,
      voucherCode,
    }));

    if (!created.ok) {
      return NextResponse.json({ error: created.error }, { status: created.status, headers: NO_STORE });
    }

    await recordActivity(request, {
      userId: session.userId,
      action: "order_create",
      details: { orderId: created.order.id, planId, method },
    });
    await notifyNewOrder({
      email: session.email,
      planName: plan.name || plan.code,
      amountNanoUsd: created.order.amountNanoUsd,
      status: created.order.status,
      method,
      orderId: created.order.id,
    });

    return NextResponse.json(
      { order: decorate(created.order), url: `/account/orders/${created.order.id}` },
      { status: 201, headers: NO_STORE }
    );
  } catch (error) {
    const message = error?.message || "Failed to create order";
    const status = /not found|not available/i.test(message) ? 404 : 400;
    return NextResponse.json({ error: message }, { status, headers: NO_STORE });
  }
}

// Exported so the UI can quote the same limit without a second constant.
export { MAX_PENDING_GATEWAY_ORDERS };
