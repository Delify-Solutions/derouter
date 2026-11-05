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
import { quoteTopup, topupBounds, topupEnabled } from "../../billing/topup.js";
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
  const blocker = await planPurchaseBlocker(db, plan, { id: user.id, groupId: user.groupId });
  if (blocker) return { text: `${planLine(plan)}\n\nChưa mua được: ${escapeHtml(blocker.reason)}`, markup: null };
  // A custom-amount plan: pick the amount first (1×, 2× the plan's price, or typed).
  if (topupEnabled(plan)) return topupChoiceReply(ctx, plan);
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

// ── Custom-amount plans (change bot-orders, D6) ───────────────────────────────

/** "Nhập số tiền": the prompt the customer replies to. The plan is named in it so the reply needs no session. */
export const AMOUNT_PROMPT_MARK = "Mã gói:";

function topupLine(plan, amountVnd) {
  const quote = quoteTopup(plan, amountVnd);
  return quote.ok ? `${formatVnd(quote.amountVnd)} → credit ${fmtUsdNano(quote.creditNanoUsd)}` : null;
}

/** Quick amounts (1 and 2 times the plan's price, inside its bounds) and "Nhập số tiền". */
export function topupChoiceReply(ctx, plan) {
  const { minVnd, maxVnd } = topupBounds(plan);
  const base = Number(plan.priceVnd) > 0 ? Number(plan.priceVnd) : minVnd;
  let quick = [1, 2]
    .map((n) => ({ n, amount: base * n }))
    .filter(({ amount }) => amount >= minVnd && amount <= maxVnd && quoteTopup(plan, amount).ok);
  // The plan's price is below its minimum: offer the minimum, as the web prefills it.
  if (quick.length === 0 && quoteTopup(plan, minVnd).ok) quick = [{ n: 1, amount: minVnd }];
  const lines = [
    `<b>${escapeHtml(plan.name || plan.code)}</b> — nạp số tiền tùy ý`,
    `Từ ${formatVnd(minVnd)} đến ${formatVnd(maxVnd)} · ${plan.durationDays} ngày`,
  ];
  for (const { n, amount } of quick) lines.push(`${n} gói${n > 1 ? ` (x${n})` : ""}: ${topupLine(plan, amount)}`);
  lines.push("", "Chọn nhanh hoặc nhập số tiền khác.");
  return {
    text: lines.join("\n"),
    markup: keyboard([
      quick.map(({ n, amount }) => ({ text: `${n} gói${n > 1 ? ` (x${n})` : ""} · ${formatVnd(amount)}`, callback_data: `ba:${plan.id}:${amount}` })),
      [{ text: "Nhập số tiền", callback_data: `bn:${plan.id}` }],
      [{ text: "Bảng giá", callback_data: "m:plans" }],
    ]),
  };
}

/** Ask for an amount: a forced reply naming the plan. */
export async function topupAskReply(ctx, planId) {
  const plan = await getPlanById(planId);
  if (!plan || !topupEnabled(plan)) return { text: "Gói này không nạp số tiền tùy ý.", markup: null };
  const blocker = await planPurchaseBlocker(ctx.db, plan, { id: ctx.user.id, groupId: ctx.user.groupId });
  if (blocker) return { text: `Chưa mua được: ${escapeHtml(blocker.reason)}`, markup: null };
  const { minVnd, maxVnd } = topupBounds(plan);
  return {
    text: `Nhập số tiền (đồng) muốn nạp cho gói <b>${escapeHtml(plan.name || plan.code)}</b>, từ ${formatVnd(minVnd)} đến ${formatVnd(maxVnd)}. Ví dụ: 500000 hoặc 500k.\n${AMOUNT_PROMPT_MARK} ${plan.id}`,
    markup: { force_reply: true, input_field_placeholder: "Số tiền, ví dụ 500000" },
  };
}

/** "500k", "1.5tr", "500.000", "500,000đ" → đồng, or null. */
export function parseVndAmount(text) {
  const raw = String(text || "").trim().toLowerCase().replace(/\s+/g, "").replace(/(đ|vnd|vnđ|d)$/u, "");
  // A unit must land on whole đồng: "1.2345k" is a typo, not 1234.5đ.
  const scaled = (digits, unit) => {
    const value = Number(digits.replace(",", ".")) * unit;
    return Number.isSafeInteger(Math.round(value)) && Math.abs(value - Math.round(value)) < 1e-6 ? Math.round(value) : null;
  };
  let m = raw.match(/^(\d+(?:[.,]\d+)?)(k|nghìn|ngàn)$/u);
  if (m) return scaled(m[1], 1000);
  m = raw.match(/^(\d+(?:[.,]\d+)?)(tr|triệu|m)$/u);
  if (m) return scaled(m[1], 1_000_000);
  if (/^\d{1,3}([.,]\d{3})+$/.test(raw)) return Number(raw.replace(/[.,]/g, ""));
  if (/^\d+$/.test(raw)) return Number(raw);
  return null;
}

/** An amount was chosen (button or typed): show it and the payment methods. */
export async function topupAmountReply(ctx, planId, rawAmount) {
  const { db, user, settings } = ctx;
  const plan = await getPlanById(planId);
  if (!plan || !topupEnabled(plan)) return { text: "Gói này không nạp số tiền tùy ý.", markup: null };
  const blocker = await planPurchaseBlocker(db, plan, { id: user.id, groupId: user.groupId });
  if (blocker) return { text: `Chưa mua được: ${escapeHtml(blocker.reason)}`, markup: null };
  const amount = typeof rawAmount === "number" ? rawAmount : parseVndAmount(rawAmount);
  const quote = amount == null ? { ok: false, error: "Không đọc được số tiền. Ví dụ: 500000 hoặc 500k." } : quoteTopup(plan, amount);
  if (!quote.ok) {
    return {
      text: escapeHtml(quote.error),
      markup: keyboard([[{ text: "Nhập lại", callback_data: `bn:${plan.id}` }, { text: "Chọn nhanh", callback_data: `bp:${plan.id}` }]]),
    };
  }
  const methods = offeredMethodsSync(db, plan, settings);
  if (methods.length === 0) return { text: "Gói này chưa có phương thức thanh toán. Vui lòng liên hệ hỗ trợ.", markup: null };
  return {
    text: [
      `<b>${escapeHtml(plan.name || plan.code)}</b> · nạp ${formatVnd(quote.amountVnd)}`,
      `Credit: <b>${fmtUsdNano(quote.creditNanoUsd)}</b> · ${plan.durationDays} ngày`,
      "",
      "Chọn cách thanh toán.",
    ].join("\n"),
    markup: keyboard([
      ...methods.map((m) => [{
        text: METHOD_TEXT[m.method] || m.label,
        callback_data: `bm:${plan.id}:${METHOD_CODE[m.method] || "m"}:${quote.amountVnd}`,
      }]),
      [{ text: "Đổi số tiền", callback_data: `bp:${plan.id}` }],
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
export async function createOrderReply(ctx, planId, methodCode, rawAmount = null) {
  const { db, user, settings } = ctx;
  const method = CODE_METHOD[methodCode];
  const plan = await getPlanById(planId);
  if (!plan || !method) return { text: "Gói hoặc phương thức không hợp lệ.", markup: null };
  // Who may buy is checked first, whatever the button carried.
  const blocker = await planPurchaseBlocker(db, plan, { id: user.id, groupId: user.groupId });
  if (blocker) return { text: `Chưa mua được: ${escapeHtml(blocker.reason)}`, markup: null };
  // A custom-amount plan is bought with an amount; a fixed plan never takes one.
  let amountVnd = null;
  let creditNanoUsd = Number(plan.creditNanoUsd) || 0;
  if (topupEnabled(plan)) {
    const quote = rawAmount != null && /^\d{1,12}$/.test(String(rawAmount)) ? quoteTopup(plan, Number(rawAmount)) : null;
    if (!quote?.ok) return topupChoiceReply(ctx, plan);
    amountVnd = quote.amountVnd;
    creditNanoUsd = quote.creditNanoUsd;
  }
  if (!offeredMethodsSync(db, plan, settings).some((m) => m.method === method)) {
    return { text: "Phương thức này không còn mở cho gói. Chọn lại.", markup: keyboard([[{ text: "Chọn lại", callback_data: `bp:${plan.id}` }]]) };
  }

  // A second tap on the same method reuses the unpaid order it made instead of
  // opening another one (and pinging the admin again).
  const reusable = db.get(
    `SELECT id FROM orders
      WHERE userId = ? AND planId = ? AND method = ? AND status = 'pending' AND creditNanoUsd = ?
        AND COALESCE(periods, 1) = 1
        AND (? IS NULL OR payCurrency != 'VND' OR payAmount = ?)
        AND (expiresAt IS NULL OR expiresAt > ?)
      ORDER BY createdAt DESC LIMIT 1`,
    [user.id, plan.id, method, creditNanoUsd, amountVnd, amountVnd, new Date().toISOString()]
  );
  if (reusable) return paymentReply(ctx, await getOrderById(reusable.id));

  let order;
  if (method === "manual") {
    try {
      order = await createOrder({ userId: user.id, planId: plan.id, method: "manual", periods: 1, amountVnd });
    } catch (error) {
      return { text: `Không tạo được đơn: ${escapeHtml(String(error?.message || "lỗi").slice(0, 200))}`, markup: null };
    }
  } else {
    const created = db.transaction(() => createGatewayOrderSync(db, { userId: user.id, plan, method, settings, periods: 1, amountVnd }));
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
    return { ...reply, text: `Chưa nhận được thanh toán.\n\n${reply.text}` };
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
