// Customer commands of the Telegram bot (change telegram-bot-commands). Each
// handler returns `{ text, markup }`; the dispatcher sends it, or edits the
// message a button was pressed on. The customer is the account linked to the
// Telegram user who wrote (users.telegramUserId): Telegram's own identity,
// authenticated by the webhook secret, never anything typed in the chat.
//
// Relative imports only: tests import this module directly.
import { getQueueSync } from "../../db/repos/accountPlansRepo.js";
import { getDebtNanoSync } from "../../billing/ledger.js";
import { listPlans } from "../../db/repos/billingRepo.js";
import { listAvailableGiftsSync, GIFT_REASON_TEXT, normalizeGiftCode } from "../../db/repos/giftRepo.js";
import { getTelegramLinkSync, setTelegramNotifyPrefsSync, unlinkTelegramSync } from "../../db/repos/telegramLinkRepo.js";
import { parseNotifyPrefs, mergeNotifyPrefs } from "../../notify/customerTelegram.js";
import { insertActivitySync } from "../../db/repos/activityRepo.js";
import { redeemForAccount } from "../../gift/redeemFlow.js";
import { channelUrlOf } from "../channel.js";
import { channelCheckConfigured } from "../channelMember.js";
import {
  escapeHtml, fmtUsdNano, formatVnd, fmtDate, vnDayStartIso, urlButton, keyboard, UNLIMITED_CREDIT_LABEL,
} from "./format.js";

export const CUSTOMER_COMMANDS = [
  { command: "me", description: "Số dư, gói đang dùng, hạn dùng" },
  { command: "usage", description: "Thống kê sử dụng hôm nay và 7 ngày" },
  { command: "gifts", description: "Mã quà có thể nhận" },
  { command: "gift", description: "Nhập mã quà: /gift MÃ" },
  { command: "plans", description: "Bảng giá các gói" },
  { command: "keys", description: "API key của bạn" },
  { command: "settings", description: "Bật/tắt thông báo, gỡ liên kết" },
  { command: "help", description: "Danh sách lệnh" },
];

export function mainMenu() {
  return keyboard([
    [{ text: "Số dư", callback_data: "m:me" }, { text: "Sử dụng", callback_data: "m:usage" }],
    [{ text: "Mã quà", callback_data: "m:gifts" }, { text: "Bảng giá", callback_data: "m:plans" }],
    [{ text: "API key", callback_data: "m:keys" }, { text: "Cài đặt", callback_data: "m:settings" }],
  ]);
}

export function helpText(siteName, { admin = false } = {}) {
  const lines = [
    `<b>${escapeHtml(siteName)}</b> · các lệnh`,
    "",
    "/me — số dư, gói đang dùng, hạn dùng",
    "/usage — thống kê sử dụng",
    "/gifts — mã quà có thể nhận",
    "/gift MÃ — nhập mã quà",
    "/plans — bảng giá các gói",
    "/keys — API key của bạn",
    "/settings — bật/tắt thông báo, gỡ liên kết",
    "/id — Telegram ID của bạn",
  ];
  if (admin) {
    lines.push("", "<b>Quản trị</b>", "/stats — số liệu hôm nay", "/orders — đơn chờ duyệt", "/user email — tra cứu tài khoản");
  }
  return lines.join("\n");
}

export function notLinkedReply(baseUrl) {
  return {
    text: "Telegram này chưa liên kết với tài khoản nào.\n\nVào trang <b>Tài khoản</b> trên web, bấm <b>Liên kết Telegram</b>, rồi quay lại đây.",
    markup: keyboard([[urlButton("Mở trang tài khoản", baseUrl, "/account")]]),
  };
}

// ── /me ─────────────────────────────────────────────────────────────────────

export function meReply(ctx) {
  const { db, user, baseUrl } = ctx;
  const queue = getQueueSync(db, user.id);
  const started = queue.filter((entry) => entry.statusLabel !== "scheduled");
  const available = started.reduce((sum, entry) => sum + Math.max(0, entry.creditRemainingNanoUsd), 0);
  const unlimited = started.some((entry) => entry.unlimitedCredit);
  const debt = getDebtNanoSync(db, user.id);
  const paying = queue.find((entry) => entry.statusLabel === "paying") ?? null;

  const lines = [
    `<b>${escapeHtml(user.email)}</b>`,
    "",
    `Credit khả dụng: <b>${unlimited ? UNLIMITED_CREDIT_LABEL : fmtUsdNano(available)}</b>`,
  ];
  if (debt > 0) lines.push(`Đang nợ: <b>${fmtUsdNano(debt)}</b> (trừ vào lần nạp sau)`);
  if (paying) {
    const left = paying.unlimitedCredit ? UNLIMITED_CREDIT_LABEL : fmtUsdNano(paying.creditRemainingNanoUsd);
    lines.push(`Gói đang trả: <b>${escapeHtml(paying.planName || "Credit")}</b> · còn ${left} · hết hạn ${fmtDate(paying.expiresAt)}`);
  } else if (queue.length === 0) {
    lines.push("Chưa có gói nào. Mua gói hoặc nhập mã quà để bắt đầu.");
  }
  const others = queue.filter((entry) => entry !== paying).slice(0, 5);
  if (others.length) {
    lines.push("", "<b>Gói trong hàng đợi</b>");
    for (const entry of others) {
      const credit = entry.unlimitedCredit ? UNLIMITED_CREDIT_LABEL : fmtUsdNano(entry.creditRemainingNanoUsd);
      const state = entry.statusLabel === "scheduled" ? `bắt đầu ${fmtDate(entry.startsAt)}` : `hết hạn ${fmtDate(entry.expiresAt)}`;
      lines.push(`• ${escapeHtml(entry.planName || "Credit")} · ${credit} · ${state}`);
    }
  }
  return {
    text: lines.join("\n"),
    markup: keyboard([
      [{ text: "Sử dụng", callback_data: "m:usage" }, { text: "Mã quà", callback_data: "m:gifts" }],
      [urlButton("Mua thêm gói", baseUrl, "/account/plans")],
    ]),
  };
}

// ── /usage ──────────────────────────────────────────────────────────────────

function chargeTotalsSync(db, userId, sinceIso) {
  const row = db.get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(-deltaNanoUsd), 0) AS spent
       FROM creditLedger WHERE userId = ? AND kind = 'charge' AND createdAt >= ?`,
    [userId, sinceIso]
  );
  return { requests: Number(row?.n) || 0, spent: Number(row?.spent) || 0 };
}

/**
 * The models a customer called most, by spend. Named by the combo they called
 * (usageHistory.meta.requestedModel), never the upstream model a customer must not
 * see (spec model-privacy); a row with no recorded combo counts as "khác".
 */
function topModelsSync(db, userId, sinceIso) {
  const rows = db.all(
    `SELECT c.deltaNanoUsd AS delta, u.meta AS usageMeta
       FROM creditLedger c LEFT JOIN usageHistory u ON u.id = c.usageId
      WHERE c.userId = ? AND c.kind = 'charge' AND c.createdAt >= ?
      ORDER BY c.id DESC LIMIT 20000`,
    [userId, sinceIso]
  );
  const byModel = new Map();
  for (const row of rows) {
    let model = "khác";
    try {
      const requested = row.usageMeta ? JSON.parse(row.usageMeta)?.requestedModel : null;
      if (typeof requested === "string" && requested) model = requested;
    } catch { /* malformed meta: "khác" */ }
    const entry = byModel.get(model) || { model, n: 0, spent: 0 };
    entry.n += 1;
    entry.spent += -Number(row.delta || 0);
    byModel.set(model, entry);
  }
  return [...byModel.values()].sort((a, b) => b.spent - a.spent).slice(0, 3);
}

export function usageReply(ctx, { now = Date.now() } = {}) {
  const { db, user, baseUrl } = ctx;
  const today = chargeTotalsSync(db, user.id, vnDayStartIso(now));
  const week = chargeTotalsSync(db, user.id, vnDayStartIso(now, 6));
  const top = topModelsSync(db, user.id, vnDayStartIso(now, 6));
  const lines = [
    "<b>Sử dụng</b>",
    "",
    `Hôm nay: <b>${today.requests}</b> request · ${fmtUsdNano(today.spent)}`,
    `7 ngày: <b>${week.requests}</b> request · ${fmtUsdNano(week.spent)}`,
  ];
  if (top.length) {
    lines.push("", "<b>Model dùng nhiều nhất (7 ngày)</b>");
    for (const row of top) lines.push(`• <code>${escapeHtml(row.model)}</code> · ${Number(row.n)} request · ${fmtUsdNano(row.spent)}`);
  }
  return { text: lines.join("\n"), markup: keyboard([[urlButton("Xem chi tiết", baseUrl, "/account/usage")]]) };
}

// ── /plans ──────────────────────────────────────────────────────────────────

export async function plansReply(ctx) {
  const { user, baseUrl } = ctx;
  const plans = (await listPlans({ onlyActive: true }))
    .filter((plan) => plan.isPurchasable !== false)
    .filter((plan) => !plan.allowedGroupIds || plan.allowedGroupIds.includes(user.groupId))
    .slice(0, 12);
  if (plans.length === 0) {
    return { text: "Hiện chưa có gói nào mở bán cho tài khoản của bạn.", markup: null };
  }
  const lines = ["<b>Bảng giá</b>", ""];
  for (const plan of plans) {
    const price = plan.allowCustomAmount
      ? "nạp số tiền tùy ý"
      : plan.priceVnd != null ? formatVnd(plan.priceVnd) : fmtUsdNano(plan.priceNanoUsd);
    const credit = plan.unlimitedCredit ? UNLIMITED_CREDIT_LABEL : plan.allowCustomAmount ? "theo số tiền" : fmtUsdNano(plan.creditNanoUsd);
    lines.push(`• <b>${escapeHtml(plan.name || plan.code)}</b> — ${price} · credit ${credit} · ${plan.durationDays} ngày`);
  }
  lines.push("", "Thanh toán trên web (chuyển khoản / USDT), gói được cộng tự động.");
  return { text: lines.join("\n"), markup: keyboard([[urlButton("Mua gói trên web", baseUrl, "/account/plans")]]) };
}

// ── /keys ───────────────────────────────────────────────────────────────────

export function keysReply(ctx) {
  const { db, user, baseUrl } = ctx;
  const rows = db.all(
    `SELECT name, key, keyPrefix, isActive, createdAt FROM apiKeys WHERE userId = ? ORDER BY createdAt ASC LIMIT 20`,
    [user.id]
  );
  if (rows.length === 0) {
    return {
      text: "Bạn chưa có API key nào. Tạo key trên web để bắt đầu gọi model.",
      markup: keyboard([[urlButton("Tạo API key", baseUrl, "/account/keys")]]),
    };
  }
  const lines = ["<b>API key</b>", "", "Key được che bớt; xem đầy đủ trên web."];
  for (const row of rows) {
    const prefix = row.keyPrefix || String(row.key || "").slice(0, 8);
    const active = row.isActive === 1 || row.isActive === true;
    lines.push(`• ${escapeHtml(String(row.name || "key").slice(0, 40))} · <code>${escapeHtml(prefix)}…</code> · ${active ? "đang bật" : "đã tắt"} · tạo ${fmtDate(row.createdAt)}`);
  }
  return { text: lines.join("\n"), markup: keyboard([[urlButton("Quản lý API key", baseUrl, "/account/keys")]]) };
}

// ── /settings ───────────────────────────────────────────────────────────────

const PREF_LABELS = { billing: "Thanh toán và gói", expiry: "Sắp hết hạn / hết credit", announcements: "Thông báo chung" };

export function settingsReply(ctx, note = "") {
  const prefs = parseNotifyPrefs(getTelegramLinkSync(ctx.db, ctx.user.id).notifyPrefs);
  const lines = [
    "<b>Thông báo qua Telegram</b>",
    "",
    ...Object.keys(PREF_LABELS).map((key) => `${PREF_LABELS[key]}: <b>${prefs[key] ? "BẬT" : "TẮT"}</b>`),
    "Bảo mật (đăng nhập, đổi mật khẩu): luôn bật",
  ];
  if (note) lines.push("", note);
  return {
    text: lines.join("\n"),
    markup: keyboard([
      ...Object.keys(PREF_LABELS).map((key) => [{
        text: `${prefs[key] ? "Tắt" : "Bật"}: ${PREF_LABELS[key]}`,
        callback_data: `n:${key}`,
      }]),
      [{ text: "Gỡ liên kết Telegram", callback_data: "u:ask" }],
    ]),
  };
}

export function togglePref(ctx, key) {
  if (!PREF_LABELS[key]) return settingsReply(ctx);
  const current = parseNotifyPrefs(getTelegramLinkSync(ctx.db, ctx.user.id).notifyPrefs);
  const next = mergeNotifyPrefs(JSON.stringify(current), { [key]: !current[key] });
  setTelegramNotifyPrefsSync(ctx.db, ctx.user.id, next);
  return settingsReply(ctx, `Đã ${next[key] ? "bật" : "tắt"} "${PREF_LABELS[key]}".`);
}

export function unlinkAsk() {
  return {
    text: "Gỡ liên kết Telegram khỏi tài khoản này?\n\nBạn sẽ không nhận thông báo qua Telegram nữa. Mã quà đã nhận vẫn được giữ.",
    markup: keyboard([[{ text: "Gỡ liên kết", callback_data: "u:yes" }, { text: "Thôi", callback_data: "m:settings" }]]),
  };
}

export function unlinkDo(ctx) {
  const changed = ctx.db.transaction(() => unlinkTelegramSync(ctx.db, ctx.user.id));
  if (changed) {
    insertActivitySync(ctx.db, { userId: ctx.user.id, action: "telegram_unlink", details: { via: "telegram_bot" } });
  }
  return { text: "Đã gỡ liên kết. Muốn liên kết lại, vào trang Tài khoản trên web.", markup: null };
}

// ── /gifts and /gift ────────────────────────────────────────────────────────

function grantText(grant) {
  if (grant.unlimitedCredit) return grant.planName ? `${grant.planName} · ${UNLIMITED_CREDIT_LABEL}` : UNLIMITED_CREDIT_LABEL;
  const credit = fmtUsdNano(grant.creditNanoUsd);
  return grant.planName ? `${grant.planName} · ${credit}` : `${credit} credit`;
}

export function giftsReply(ctx) {
  const { db, user, settings } = ctx;
  const includeChannel = channelCheckConfigured(settings) && Boolean(channelUrlOf(settings));
  const codes = listAvailableGiftsSync(db, user.id, { includeChannel }).slice(0, 8);
  if (codes.length === 0) {
    return { text: "Hiện chưa có mã quà nào dành cho bạn. Có mã thì gõ: <code>/gift MÃ</code>", markup: null };
  }
  const lines = ["<b>Mã có thể sử dụng</b>", ""];
  for (const gift of codes) {
    const note = gift.kind === "channel" ? " · cần tham gia kênh" : gift.kind === "new_user" ? " · người mới" : "";
    lines.push(`• <code>${escapeHtml(gift.code)}</code> — ${escapeHtml(grantText(gift.grant))}${note}`);
  }
  const channelUrl = channelUrlOf(settings);
  return {
    text: lines.join("\n"),
    markup: keyboard([
      ...codes.map((gift) => [{ text: `Nhận ${grantText(gift.grant)}`.slice(0, 60), callback_data: `g:${normalizeGiftCode(gift.code)}` }]),
      [codes.some((gift) => gift.kind === "channel") && channelUrl ? { text: "Mở kênh Telegram", url: channelUrl } : null],
    ]),
  };
}

const REFUSAL_TEXT = {
  not_found: "Mã không hợp lệ hoặc đã hết lượt.",
  not_active: "Mã không hợp lệ hoặc đã hết lượt.",
  exhausted: "Mã không hợp lệ hoặc đã hết lượt.",
  already_redeemed: "Bạn đã dùng mã này rồi.",
  invalid_plan: "Mã này không áp dụng được cho tài khoản của bạn.",
  not_new_user: GIFT_REASON_TEXT.not_new_user,
  telegram_used: GIFT_REASON_TEXT.telegram_used,
  telegram_channel_used: GIFT_REASON_TEXT.telegram_channel_used,
  telegram_required: "Cần liên kết Telegram để nhận mã này.",
  channel_required: "Bạn chưa ở trong kênh Telegram. Tham gia kênh rồi bấm Thử lại.",
  too_soon: "Vui lòng đợi vài giây rồi thử lại.",
  channel_unavailable: "Chưa kiểm tra được kênh Telegram lúc này. Vui lòng thử lại sau ít phút.",
};

export async function redeemReply(ctx, rawCode) {
  const code = normalizeGiftCode(rawCode).slice(0, 32);
  if (code.length < 4) {
    return { text: "Gõ mã sau lệnh, ví dụ: <code>/gift WELCOME2026</code>", markup: null };
  }
  const { db, user, settings } = ctx;
  // Tests inject the Telegram membership check and the spacing.
  const flow = await redeemForAccount(db, {
    userId: user.id, code, settings,
    ...(ctx.checkMember ? { checkMember: ctx.checkMember } : {}),
    ...(ctx.reserve ? { reserve: ctx.reserve } : {}),
  });
  if (!flow.ok) {
    if (flow.reason !== "too_soon" && flow.reason !== "channel_unavailable") {
      insertActivitySync(db, { userId: user.id, action: "gift_refused", details: { code, reason: flow.reason, via: "telegram_bot" } });
    }
    const retry = flow.reason === "channel_required";
    return {
      text: REFUSAL_TEXT[flow.reason] || REFUSAL_TEXT.not_found,
      markup: retry ? keyboard([[
        flow.channelUrl ? { text: "Mở kênh Telegram", url: flow.channelUrl } : null,
        { text: "Thử lại", callback_data: `g:${code}` },
      ]]) : null,
    };
  }
  const { result, channelOffer } = flow;
  insertActivitySync(db, {
    userId: user.id, action: "gift_redeem", details: { code, userPlanId: result.userPlan?.id ?? null, via: "telegram_bot" },
  });
  const plan = result.userPlan || {};
  const credit = Number(plan.unlimitedCredit) === 1 ? UNLIMITED_CREDIT_LABEL : fmtUsdNano(plan.creditTotalNanoUsd ?? 0);
  const lines = [
    `Đã nhận mã <code>${escapeHtml(code)}</code>`,
    `${result.planName ? `Gói ${escapeHtml(result.planName)} · ` : ""}${credit} · hết hạn ${fmtDate(plan.expiresAt)}`,
  ];
  if ((result.appliedToOverdraftNanoUsd ?? 0) > 0) {
    lines.push(`${fmtUsdNano(result.appliedToOverdraftNanoUsd)} trong số này đã trả khoản nợ trước.`);
  }
  let markup = keyboard([[{ text: "Xem số dư", callback_data: "m:me" }]]);
  if (channelOffer) {
    lines.push("", `Tham gia kênh Telegram để nhận thêm <b>${escapeHtml(grantText(channelOffer))}</b> (mã <code>${escapeHtml(channelOffer.code)}</code>).`);
    markup = keyboard([
      [{ text: "Mở kênh Telegram", url: channelOffer.channelUrl }],
      [{ text: "Tôi đã tham gia, nhận ngay", callback_data: `g:${normalizeGiftCode(channelOffer.code)}` }],
    ]);
  }
  return { text: lines.join("\n"), markup };
}
