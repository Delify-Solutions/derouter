// Admin commands of the Telegram bot (change telegram-bot-commands). Only the
// Telegram user ids the admin listed in settings (`telegramAdminIds`) reach
// these; the id is Telegram's own (`from.id`), authenticated by the webhook
// secret. Approving or cancelling an order always takes a second tap.
//
// Relative imports only: tests import this module directly.
import { listOrders, getOrderById, approveOrder, updateOrderStatus } from "../../db/repos/billingRepo.js";
import { getQueueSync } from "../../db/repos/accountPlansRepo.js";
import { getDebtNanoSync } from "../../billing/ledger.js";
import { insertAuditSync } from "../../billing/audit.js";
import { fireAndForget, notifyOrderApproved } from "../../notify/customerTelegram.js";
import {
  escapeHtml, fmtUsdNano, fmtDate, fmtDateTime, vnDayStartIso, orderAmountText, totalsText, urlButton, keyboard,
  UNLIMITED_CREDIT_LABEL,
} from "./format.js";

export const ADMIN_COMMANDS = [
  { command: "stats", description: "Quản trị: số liệu hôm nay" },
  { command: "orders", description: "Quản trị: đơn chờ duyệt" },
  { command: "user", description: "Quản trị: tra cứu tài khoản (/user email)" },
];

/** The admin Telegram ids from settings: an array or a comma/space separated string of digits. */
export function adminIdsOf(settings) {
  const raw = settings?.telegramAdminIds;
  const list = Array.isArray(raw) ? raw : String(raw ?? "").split(/[\s,;]+/);
  return [...new Set(list.map((id) => String(id).trim()).filter((id) => /^\d{1,20}$/.test(id)))];
}

export function isAdmin(settings, telegramUserId) {
  return adminIdsOf(settings).includes(String(telegramUserId));
}

/** "telegram:123456 (@name)": who acted, for approvedBy and the audit log. */
export function adminActor(from) {
  return `telegram:${from.id}${from.username ? ` (@${from.username})` : ""}`;
}

// ── /stats ──────────────────────────────────────────────────────────────────

export function statsReply(ctx, { now = Date.now() } = {}) {
  const { db, baseUrl } = ctx;
  const since = vnDayStartIso(now);
  const users = db.get(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN createdAt >= ? THEN 1 ELSE 0 END) AS today FROM users`,
    [since]
  );
  const paid = db.all(
    `SELECT COALESCE(payCurrency, 'USD') AS currency, COUNT(*) AS n,
            COALESCE(SUM(COALESCE(payAmount, amountNanoUsd, 0)), 0) AS total
       FROM orders WHERE status = 'paid' AND paidAt >= ?
      GROUP BY COALESCE(payCurrency, 'USD')`,
    [since]
  );
  const pending = db.get(`SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'`);
  const charges = db.get(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT userId) AS users, COALESCE(SUM(-deltaNanoUsd), 0) AS spent
       FROM creditLedger WHERE kind = 'charge' AND createdAt >= ?`,
    [since]
  );
  const gifts = db.get(`SELECT COUNT(*) AS n FROM giftRedemptions WHERE redeemedAt >= ?`, [since]);
  const paidCount = paid.reduce((sum, row) => sum + Number(row.n || 0), 0);
  const lines = [
    `<b>Hôm nay</b> (từ 00:00 giờ Việt Nam)`,
    "",
    `Tài khoản mới: <b>${Number(users?.today) || 0}</b> · tổng ${Number(users?.total) || 0}`,
    `Đơn đã thanh toán: <b>${paidCount}</b> · ${totalsText(paid)}`,
    `Đơn chờ duyệt: <b>${Number(pending?.n) || 0}</b>`,
    `Request tính phí: <b>${Number(charges?.n) || 0}</b> · ${Number(charges?.users) || 0} khách · ${fmtUsdNano(charges?.spent)}`,
    `Mã quà đã nhập: <b>${Number(gifts?.n) || 0}</b>`,
  ];
  return {
    text: lines.join("\n"),
    markup: keyboard([[{ text: "Đơn chờ duyệt", callback_data: "a:orders" }], [urlButton("Mở trang quản trị", baseUrl, "/dashboard")]]),
  };
}

// ── /orders ─────────────────────────────────────────────────────────────────

function orderLine(order) {
  const who = order.userEmail || order.userId;
  return `<b>${escapeHtml(order.planName || order.planCode || "Gói")}</b> · ${orderAmountText(order)} · ${escapeHtml(order.method)}\n`
    + `${escapeHtml(who)} · ${fmtDateTime(order.createdAt)} · <code>${escapeHtml(order.id.slice(0, 8))}</code>`;
}

export async function ordersReply(ctx, note = "") {
  const { orders, total } = await listOrders({ status: "pending", limit: 8 });
  if (orders.length === 0) {
    return { text: `${note ? `${note}\n\n` : ""}Không có đơn nào chờ duyệt.`, markup: null };
  }
  const lines = [];
  if (note) lines.push(note, "");
  lines.push(`<b>Đơn chờ duyệt</b> (${total})`, "");
  orders.forEach((order, i) => lines.push(`${i + 1}. ${orderLine(order)}`));
  if (total > orders.length) lines.push("", `Còn ${total - orders.length} đơn nữa trên web.`);
  return {
    text: lines.join("\n"),
    markup: keyboard([
      ...orders.map((order, i) => [
        { text: `${i + 1}. Duyệt`, callback_data: `oa:${order.id}` },
        { text: `${i + 1}. Hủy`, callback_data: `oc:${order.id}` },
      ]),
      [{ text: "Làm mới", callback_data: "a:orders" }, urlButton("Mở trên web", ctx.baseUrl, "/dashboard/orders")],
    ]),
  };
}

export async function orderConfirmReply(orderId, action) {
  const order = await getOrderById(orderId);
  if (!order) return { text: "Không tìm thấy đơn.", markup: keyboard([[{ text: "Danh sách đơn", callback_data: "a:orders" }]]) };
  if (order.status !== "pending") {
    return { text: `Đơn đã ở trạng thái "${escapeHtml(order.status)}".`, markup: keyboard([[{ text: "Danh sách đơn", callback_data: "a:orders" }]]) };
  }
  const verb = action === "approve" ? "DUYỆT" : "HỦY";
  return {
    text: `${verb} đơn này?\n\n${orderLine(order)}${action === "approve" ? "\n\nKhách nhận gói ngay sau khi duyệt." : ""}`,
    markup: keyboard([[
      { text: action === "approve" ? "Xác nhận duyệt" : "Xác nhận hủy", callback_data: `${action === "approve" ? "oy" : "ox"}:${order.id}` },
      { text: "Quay lại", callback_data: "a:orders" },
    ]]),
  };
}

export async function approveDo(ctx, orderId) {
  let note;
  // A stale button on an order that left "pending" (cancelled, expired): say so in
  // Vietnamese instead of passing the repo's English error through.
  const current = await getOrderById(orderId);
  if (current && current.status !== "pending" && current.status !== "paid" && current.status !== "refunded") {
    return ordersReply(ctx, `Không duyệt được: đơn đang ở trạng thái "${escapeHtml(current.status)}".`);
  }
  try {
    const result = await approveOrder(orderId, adminActor(ctx.from));
    if (!result) note = "Không tìm thấy đơn.";
    else if (result.alreadyApproved) note = "Đơn đã được duyệt trước đó.";
    else {
      fireAndForget(notifyOrderApproved(orderId));
      note = `Đã duyệt đơn <code>${escapeHtml(orderId.slice(0, 8))}</code>.`;
    }
  } catch (error) {
    note = `Không duyệt được: ${escapeHtml(String(error?.message || "lỗi").slice(0, 200))}`;
  }
  return ordersReply(ctx, note);
}

export async function cancelDo(ctx, orderId) {
  let note;
  const order = await getOrderById(orderId);
  if (!order) note = "Không tìm thấy đơn.";
  else if (order.status !== "pending") note = `Đơn đã ở trạng thái "${escapeHtml(order.status)}".`;
  else {
    // Guarded: a gateway payment approved since the read above must win.
    // No approvedBy: the dashboard shows it as "approved by". The audit row below
    // records who cancelled.
    const updated = await updateOrderStatus(orderId, {
      status: "cancelled", fromStatus: "pending", adminNote: "Hủy qua Telegram",
    });
    if (updated?.changed) {
      insertAuditSync(ctx.db, {
        userId: order.userId, actor: adminActor(ctx.from), action: "order_cancelled",
        details: { orderId, via: "telegram_bot" },
      });
      note = `Đã hủy đơn <code>${escapeHtml(orderId.slice(0, 8))}</code>.`;
    } else {
      note = `Không hủy được: đơn đang ở trạng thái "${escapeHtml(updated?.status ?? "?")}".`;
    }
  }
  return ordersReply(ctx, note);
}

// ── /user ───────────────────────────────────────────────────────────────────

export function userReply(ctx, query) {
  const { db, baseUrl } = ctx;
  const q = String(query || "").trim();
  if (!q) return { text: "Gõ email, ID hoặc @username Telegram sau lệnh, ví dụ: <code>/user a@b.com</code>", markup: null };
  const user = q.startsWith("@")
    ? db.get(`SELECT * FROM users WHERE lower(telegramUsername) = lower(?)`, [q.slice(1)])
    : db.get(`SELECT * FROM users WHERE id = ? OR lower(email) = lower(?)`, [q, q]);
  if (!user) return { text: "Không tìm thấy tài khoản.", markup: null };

  const queue = getQueueSync(db, user.id);
  const started = queue.filter((entry) => entry.statusLabel !== "scheduled");
  const available = started.reduce((sum, entry) => sum + Math.max(0, entry.creditRemainingNanoUsd), 0);
  const unlimited = started.some((entry) => entry.unlimitedCredit);
  const debt = getDebtNanoSync(db, user.id);
  const group = user.groupId ? db.get(`SELECT name FROM keyGroups WHERE id = ?`, [user.groupId]) : null;
  const orders = db.get(
    `SELECT COUNT(*) AS n FROM orders WHERE userId = ? AND status = 'paid'`,
    [user.id]
  );
  const lines = [
    `<b>${escapeHtml(user.email)}</b>`,
    `ID <code>${escapeHtml(user.id)}</code> · ${escapeHtml(user.status)}`,
    `Nhóm: ${escapeHtml(group?.name || "—")}`,
    `Telegram: ${user.telegramUserId ? `${user.telegramUsername ? `@${escapeHtml(user.telegramUsername)}` : "đã liên kết"} (${escapeHtml(user.telegramUserId)})` : "chưa liên kết"}`,
    `Credit khả dụng: <b>${unlimited ? UNLIMITED_CREDIT_LABEL : fmtUsdNano(available)}</b> · ${queue.length} gói${debt > 0 ? ` · nợ ${fmtUsdNano(debt)}` : ""}`,
    `Đơn đã thanh toán: ${Number(orders?.n) || 0}`,
    `Tạo: ${fmtDate(user.createdAt)} · đăng nhập gần nhất: ${user.lastLoginAt ? fmtDateTime(user.lastLoginAt) : "—"}`,
  ];
  return {
    text: lines.join("\n"),
    markup: keyboard([[urlButton("Mở trong trang quản trị", baseUrl, `/dashboard/users/${encodeURIComponent(user.id)}`)]]),
  };
}
