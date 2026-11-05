// Buying a plan from the Telegram bot (change bot-orders). The same rules as the
// web checkout: `planPurchaseBlocker` decides who may buy, `offeredMethodsSync`
// which methods a plan offers, `createGatewayOrderSync` / `createOrder` write the
// order, `buildPaymentBlock` gives the exact transfer details. The gateway pollers
// and webhooks then pay the order as for any other, and the customer's linked
// Telegram is told when it is paid (notifyOrderApproved).
//
// Relative imports only: tests import this module directly.
import { getPlanById, planPurchaseBlocker, createOrder, getOrderById, updateOrderStatus, listOrders } from "../../db/repos/billingRepo.js";
import { createGatewayOrderSync, offeredMethodsSync } from "../../payments/checkout.js";
import { buildPaymentBlock } from "../../payments/orderPayment.js";
import { insertActivitySync } from "../../db/repos/activityRepo.js";
import { parseJson } from "../../db/helpers/jsonCol.js";
import {
  escapeHtml, fmtUsdNano, formatVnd, fmtDateTime, urlButton, keyboard, UNLIMITED_CREDIT_LABEL,
} from "./format.js";

// Callback method codes (callback_data stays short).
const METHOD_CODE = { vietqr: "v", binance: "b", manual: "m" };
const CODE_METHOD = { v: "vietqr", b: "binance", m: "manual" };
const METHOD_TEXT = { vietqr: "Chuyển khoản VietQR", binance: "Binance Pay (USDT)", manual: "Đơn thủ công (admin duyệt)" };
const STATUS_TEXT = {
  pending: "chờ thanh toán", paid: "đã thanh toán", cancelled: "đã hủy", expired: "hết hạn", refunded: "đã hoàn tiền",
};

function planLine(plan) {
  const price = plan.priceVnd != null ? formatVnd(plan.priceVnd) : fmtUsdNano(plan.priceNanoUsd);
  const credit = plan.unlimitedCredit ? UNLIMITED_CREDIT_LABEL : fmtUsdNano(plan.creditNanoUsd);
  return `<b>${escapeHtml(plan.name || plan.code)}</b> — ${price} · credit ${credit} · ${plan.durationDays} ngày`;
}

/** Plan detail with one button per payment method the plan offers to this customer. */
export async function planBuyReply(ctx, planId) {
  const { db, user, settings, baseUrl } = ctx;
  const plan = await getPlanById(planId);
  if (!plan) return { text: "Gói không tồn tại.", markup: null };
  // A custom-amount plan or a longer term needs the web form.
  if (plan.allowCustomAmount) {
    return {
      text: `${planLine(plan)}\n\nGói nạp số tiền tùy ý: chọn số tiền trên web.`,
      markup: keyboard([[urlButton("Mua trên web", baseUrl, "/account/plans")]]),
    };
  }
  const blocker = await planPurchaseBlocker(db, plan, { id: user.id, groupId: user.groupId });
  if (blocker) return { text: `${planLine(plan)}\n\nChưa mua được: ${escapeHtml(blocker.reason)}`, markup: null };
  const methods = offeredMethodsSync(db, plan, settings);
  if (methods.length === 0) {
    return { text: `${planLine(plan)}\n\nGói này chưa có phương thức thanh toán. Vui lòng liên hệ hỗ trợ.`, markup: null };
  }
  const lines = [planLine(plan)];
  if (plan.description) lines.push(escapeHtml(String(plan.description).slice(0, 300)));
  lines.push("", "Chọn cách thanh toán (1 kỳ). Gói nhiều kỳ, voucher: mua trên web.");
  return {
    text: lines.join("\n"),
    markup: keyboard([
      ...methods.map((m) => [{
        text: `${METHOD_TEXT[m.method] || m.label}${m.amountText ? ` · ${m.amountText}` : ""}`.slice(0, 60),
        callback_data: `bm:${plan.id}:${METHOD_CODE[m.method] || "m"}`,
      }]),
      [{ text: "Bảng giá", callback_data: "m:plans" }, urlButton("Nhiều kỳ / voucher: mua trên web", baseUrl, "/account/plans")],
    ]),
  };
}

function loadProviderSync(db, providerId) {
  if (!providerId) return null;
  const row = db.get(`SELECT id, kind, name, config FROM paymentProviders WHERE id = ?`, [providerId]);
  // Only the public config; `secrets` is never selected.
  return row ? { id: row.id, kind: row.kind, name: row.name, config: parseJson(row.config, {}) ?? {} } : null;
}

/** What to pay and how, for a pending order, plus its buttons. `photo` is the QR image when there is one. */
export function paymentReply(ctx, order) {
  const plan = escapeHtml(order.planName || order.planCode || "Gói");
  const buttons = keyboard([
    [{ text: "Kiểm tra thanh toán", callback_data: `us:${order.id}` }, { text: "Hủy đơn", callback_data: `uc:${order.id}` }],
    [urlButton("Xem trên web", ctx.baseUrl, `/account/orders/${order.id}`)],
  ]);
  const block = buildPaymentBlock({ order, provider: loadProviderSync(ctx.db, order.paymentProviderId) });
  if (!block) {
    return {
      text: [`Đơn <b>${plan}</b> đã tạo, đang chờ admin duyệt.`, `Mã đơn: <code>${escapeHtml(order.id.slice(0, 8))}</code>`].join("\n"),
      markup: buttons,
    };
  }
  const lines = [`Đơn <b>${plan}</b> · cần thanh toán <b>${escapeHtml(block.amountText)}</b>`, ""];
  if (block.method === "vietqr") {
    if (block.bankName) lines.push(`Ngân hàng: <b>${escapeHtml(block.bankName)}</b>`);
    if (block.accountNumber) lines.push(`Số tài khoản: <code>${escapeHtml(block.accountNumber)}</code>`);
    if (block.accountName) lines.push(`Chủ tài khoản: ${escapeHtml(block.accountName)}`);
    lines.push(`Số tiền: <code>${escapeHtml(String(block.amount))}</code>`);
    lines.push(`Nội dung: <code>${escapeHtml(block.content)}</code>`);
  } else {
    if (block.payUid) lines.push(`Binance Pay ID: <code>${escapeHtml(block.payUid)}</code>`);
    if (block.accountName) lines.push(`Người nhận: ${escapeHtml(block.accountName)}`);
    lines.push(`Số tiền: <code>${escapeHtml(block.amountUsdt)}</code> USDT`);
    lines.push(`Ghi chú (Note): <code>${escapeHtml(block.content)}</code>`);
  }
  if (order.expiresAt) lines.push(`Hết hạn: ${fmtDateTime(order.expiresAt)}`);
  lines.push("", escapeHtml(block.instruction), "Gói được kích hoạt tự động khi nhận tiền; bot sẽ báo bạn.");
  return {
    text: lines.join("\n"),
    markup: buttons,
    photo: block.method === "vietqr" ? block.qrUrl : block.qrImageUrl || null,
  };
}

/** Create the order the customer picked, then the payment details. */
export async function createOrderReply(ctx, planId, methodCode) {
  const { db, user, settings } = ctx;
  const method = CODE_METHOD[methodCode];
  const plan = await getPlanById(planId);
  if (!plan || !method) return { text: "Gói hoặc phương thức không hợp lệ.", markup: null };
  if (plan.allowCustomAmount) return planBuyReply(ctx, planId);
  const blocker = await planPurchaseBlocker(db, plan, { id: user.id, groupId: user.groupId });
  if (blocker) return { text: `Chưa mua được: ${escapeHtml(blocker.reason)}`, markup: null };
  if (!offeredMethodsSync(db, plan, settings).some((m) => m.method === method)) {
    return { text: "Phương thức này không còn mở cho gói. Chọn lại.", markup: keyboard([[{ text: "Chọn lại", callback_data: `bp:${plan.id}` }]]) };
  }

  // A second tap on the same method reuses the unpaid order it made instead of
  // opening another one (and pinging the admin again).
  const reusable = db.get(
    `SELECT id FROM orders
      WHERE userId = ? AND planId = ? AND method = ? AND status = 'pending'
        AND (expiresAt IS NULL OR expiresAt > ?)
      ORDER BY createdAt DESC LIMIT 1`,
    [user.id, plan.id, method, new Date().toISOString()]
  );
  if (reusable) return paymentReply(ctx, await getOrderById(reusable.id));

  let order;
  if (method === "manual") {
    try {
      order = await createOrder({ userId: user.id, planId: plan.id, method: "manual", periods: 1 });
    } catch (error) {
      return { text: `Không tạo được đơn: ${escapeHtml(String(error?.message || "lỗi").slice(0, 200))}`, markup: null };
    }
  } else {
    const created = db.transaction(() => createGatewayOrderSync(db, { userId: user.id, plan, method, settings, periods: 1 }));
    if (!created.ok) return { text: `Không tạo được đơn: ${escapeHtml(created.error)}`, markup: null };
    order = created.order;
  }
  // The order exists from here on: logging and the admin ping are best effort,
  // the customer must still get the payment details.
  try {
    insertActivitySync(db, {
      userId: user.id, action: "order_create", details: { orderId: order.id, planId: plan.id, method, via: "telegram_bot" },
    });
  } catch (error) {
    console.error(`[telegram-bot] order activity not logged: ${String(error?.message || "error").slice(0, 200)}`);
  }
  try {
    const ping = ctx.onOrderCreated?.({
      email: user.email, planName: plan.name || plan.code, amountNanoUsd: order.amountNanoUsd,
      status: order.status, method, orderId: order.id,
    });
    // Not awaited: the customer is not kept waiting for the admin chat.
    Promise.resolve(ping).catch(() => {});
  } catch {
    /* the notifier is a courtesy */
  }
  const saved = await getOrderById(order.id);
  // Fully covered by discounts: approved on creation, nothing to pay.
  if (saved?.status === "paid") {
    return { text: `Đơn <b>${escapeHtml(plan.name || plan.code)}</b> đã được kích hoạt, không cần thanh toán.`, markup: keyboard([[{ text: "Xem số dư", callback_data: "m:me" }]]) };
  }
  return paymentReply(ctx, saved);
}

async function ownOrder(ctx, orderId) {
  const order = await getOrderById(orderId);
  return order && order.userId === ctx.user.id ? order : null;
}

/** "Kiểm tra thanh toán": paid → done; pending → the details again. */
export async function orderStatusReply(ctx, orderId) {
  const order = await ownOrder(ctx, orderId);
  if (!order) return { text: "Không tìm thấy đơn.", markup: null };
  if (order.status === "pending") {
    const reply = paymentReply(ctx, order);
    return { ...reply, photo: null, text: `Chưa nhận được thanh toán.\n\n${reply.text}` };
  }
  if (order.status === "paid") {
    return { text: `Đơn <b>${escapeHtml(order.planName || "")}</b> đã thanh toán, gói đã được kích hoạt.`, markup: keyboard([[{ text: "Xem số dư", callback_data: "m:me" }]]) };
  }
  return { text: `Đơn đang ở trạng thái: ${STATUS_TEXT[order.status] || escapeHtml(order.status)}.`, markup: null };
}

/** The customer cancels a still-pending order; a payment that landed first wins. */
export async function cancelOwnOrderReply(ctx, orderId) {
  const order = await ownOrder(ctx, orderId);
  if (!order) return { text: "Không tìm thấy đơn.", markup: null };
  if (order.status !== "pending") return { text: `Không hủy được: đơn ${STATUS_TEXT[order.status] || escapeHtml(order.status)}.`, markup: null };
  const updated = await updateOrderStatus(orderId, { status: "cancelled", fromStatus: "pending" });
  if (!updated?.changed) return { text: `Không hủy được: đơn ${STATUS_TEXT[updated?.status] || "đã đổi trạng thái"}.`, markup: null };
  insertActivitySync(ctx.db, { userId: ctx.user.id, action: "order_cancel", details: { orderId, via: "telegram_bot" } });
  return { text: "Đã hủy đơn.", markup: keyboard([[{ text: "Bảng giá", callback_data: "m:plans" }]]) };
}

/** /myorders: the customer's latest orders; pending ones can be paid or cancelled. */
export async function myOrdersReply(ctx) {
  const { orders } = await listOrders({ userId: ctx.user.id, limit: 8 });
  if (orders.length === 0) {
    return { text: "Bạn chưa có đơn nào. Gõ /plans để mua gói.", markup: keyboard([[{ text: "Bảng giá", callback_data: "m:plans" }]]) };
  }
  const lines = ["<b>Đơn hàng gần đây</b>", ""];
  orders.forEach((order, i) => {
    const amount = order.payCurrency === "VND" && order.payAmount != null ? formatVnd(order.payAmount) : fmtUsdNano(order.amountNanoUsd);
    lines.push(`${i + 1}. ${escapeHtml(order.planName || order.planCode || "Gói")} · ${amount} · ${STATUS_TEXT[order.status] || escapeHtml(order.status)} · ${fmtDateTime(order.createdAt)}`);
  });
  const pending = orders.map((order, i) => [order, i]).filter(([order]) => order.status === "pending");
  return {
    text: lines.join("\n"),
    markup: keyboard(pending.map(([order, i]) => [
      { text: `${i + 1}. Thanh toán`, callback_data: `up:${order.id}` },
      { text: `${i + 1}. Hủy`, callback_data: `uc:${order.id}` },
    ])),
  };
}

/** Payment details again for a pending order. */
export async function payAgainReply(ctx, orderId) {
  const order = await ownOrder(ctx, orderId);
  if (!order) return { text: "Không tìm thấy đơn.", markup: null };
  if (order.status !== "pending") return orderStatusReply(ctx, orderId);
  return paymentReply(ctx, order);
}
