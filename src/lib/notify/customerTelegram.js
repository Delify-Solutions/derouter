// Notifications to customers over their linked Telegram (spec telegram-notify).
//
// Every entry point is fire-and-forget: it never throws and never fails the
// action that triggered it (a payment, a login, a key). Messages go to the
// Telegram user id stored by the Mini App link — for a private chat the chat id
// is the user id. Groups a customer can turn off: billing, expiry,
// announcements. Security messages are always sent.
//
// Relative imports only: tests import this module directly.

import { getAdapter } from "../db/driver.js";
import { getSettings } from "../db/repos/settingsRepo.js";
import { fmtCreditNano } from "../../shared/utils/money.js";
import { escapeHtml, sendTelegramMessage } from "./telegramApi.js";

export const NOTIFY_GROUPS = ["billing", "expiry", "announcements"];
export const SECURITY = "security";

const DATE_FORMAT = new Intl.DateTimeFormat("vi-VN", {
  timeZone: "Asia/Ho_Chi_Minh",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * "Chrome trên macOS" from a User-Agent; anything unrecognised is shortened
 * rather than dropped, so a script (curl, python) still shows what it was.
 */
export function describeUserAgent(userAgent) {
  const ua = String(userAgent || "");
  if (!ua) return "";
  const browser =
    /Edg(e|A|iOS)?\//.test(ua) ? "Edge"
      : /OPR\/|Opera/.test(ua) ? "Opera"
      : /CocCoc|coc_coc/i.test(ua) ? "Cốc Cốc"
      : /Telegram/i.test(ua) ? "Telegram"
      : /Firefox\/|FxiOS\//.test(ua) ? "Firefox"
      : /Chrome\/|CriOS\//.test(ua) ? "Chrome"
      : /Safari\//.test(ua) ? "Safari"
      : null;
  // iPadOS 13+ in desktop mode sends a Macintosh UA and reads as macOS: the
  // server cannot tell them apart, so do not try.
  const os =
    /iPhone|iPad|iPod/.test(ua) ? "iOS"
      : /Android/.test(ua) ? "Android"
      : /Windows/.test(ua) ? "Windows"
      : /Mac OS X|Macintosh/.test(ua) ? "macOS"
      : /CrOS/.test(ua) ? "ChromeOS"
      : /Linux/.test(ua) ? "Linux"
      : null;
  if (browser && os) return `${browser} trên ${os}`;
  if (browser || os) return browser || os;
  return ua.slice(0, 60);
}

export function formatDate(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : DATE_FORMAT.format(date);
}

/** Stored prefs → `{ billing, expiry, announcements }`, every group on unless explicitly false. */
export function parseNotifyPrefs(text) {
  let raw = {};
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    raw = {};
  }
  const prefs = {};
  for (const group of NOTIFY_GROUPS) prefs[group] = raw?.[group] !== false;
  return prefs;
}

/** Merge a partial update from the customer; unknown keys and non-booleans are ignored. */
export function mergeNotifyPrefs(currentText, update) {
  const prefs = parseNotifyPrefs(currentText);
  for (const group of NOTIFY_GROUPS) {
    if (typeof update?.[group] === "boolean") prefs[group] = update[group];
  }
  return prefs;
}

async function loadBot() {
  try {
    const settings = (await getSettings()) || {};
    const token = typeof settings.telegramBotToken === "string" ? settings.telegramBotToken.trim() : "";
    const siteName = typeof settings.siteName === "string" && settings.siteName.trim() ? settings.siteName.trim() : "derouter";
    return { token, siteName };
  } catch {
    return { token: "", siteName: "derouter" };
  }
}

// Test seam: tests replace the transport instead of the global fetch.
let transport = sendTelegramMessage;
export function setTelegramTransportForTests(fn) {
  transport = fn || sendTelegramMessage;
}

/**
 * Deliver one message to a linked customer, honouring their preferences and the
 * blocked marker. Updates the marker from Telegram's answer.
 *
 * @param {string} userId
 * @param {"billing"|"expiry"|"announcements"|"security"} group
 * @param {(siteName: string) => string} buildText HTML text, built once the site name is known
 * @param {{ force?: boolean }} [options] force: try even when marked blocked (test message, fresh link)
 * @returns {Promise<{ ok: boolean, reason?: string, retryAfterSec?: number }>}
 */
export async function notifyCustomer(userId, group, buildText, { force = false } = {}) {
  try {
    if (!userId) return { ok: false, reason: "no_user" };
    const { token, siteName } = await loadBot();
    if (!token) return { ok: false, reason: "not_configured" };
    const db = await getAdapter();
    const row = db.get(
      `SELECT telegramUserId, telegramNotifyPrefs, telegramDmBlockedAt, status FROM users WHERE id = ?`,
      [userId]
    );
    if (!row?.telegramUserId) return { ok: false, reason: "not_linked" };
    // Only security messages (a suspension notice among them) reach an inactive account.
    if (group !== SECURITY && row.status !== "active") return { ok: false, reason: "inactive" };
    if (group !== SECURITY && parseNotifyPrefs(row.telegramNotifyPrefs)[group] === false) {
      return { ok: false, reason: "opted_out" };
    }
    if (row.telegramDmBlockedAt && !force) return { ok: false, reason: "blocked" };

    const text = typeof buildText === "function" ? buildText(siteName) : String(buildText || "");
    if (!text) return { ok: false, reason: "empty" };
    const result = await transport(token, row.telegramUserId, text);
    markDelivery(db, userId, row, result);
    return result;
  } catch (error) {
    console.error(`[notify] customer telegram skipped: ${error?.message || "unknown error"}`);
    return { ok: false, reason: "error" };
  }
}

// Remember that Telegram refuses this chat (stop trying), or that it works again.
// Keyed on the Telegram id too, so a re-link in between is not overwritten.
function markDelivery(db, userId, row, result) {
  if (result?.blocked) {
    db.run(
      `UPDATE users SET telegramDmBlockedAt = ? WHERE id = ? AND telegramUserId = ?`,
      [new Date().toISOString(), userId, row.telegramUserId]
    );
  } else if (result?.ok && row.telegramDmBlockedAt) {
    db.run(`UPDATE users SET telegramDmBlockedAt = NULL WHERE id = ? AND telegramUserId = ?`, [userId, row.telegramUserId]);
  }
}

/** Run a notification without awaiting it; the caller's response never waits on Telegram. */
export function fireAndForget(promise) {
  Promise.resolve(promise).catch(() => {});
}

// ── Message texts ────────────────────────────────────────────────────────────

function header(siteName, title) {
  return `<b>${escapeHtml(siteName)}</b> · ${escapeHtml(title)}`;
}

function planLines({ planName, creditNanoUsd, unlimitedCredit, startsAt, expiresAt }) {
  const lines = [];
  if (planName) lines.push(`Gói: <b>${escapeHtml(planName)}</b>`);
  if (unlimitedCredit) lines.push("Credit: không giới hạn");
  else if (creditNanoUsd != null) lines.push(`Credit: <code>${escapeHtml(fmtCreditNano(creditNanoUsd))}</code>`);
  if (startsAt && new Date(startsAt).getTime() > Date.now() + 60_000) {
    lines.push(`Bắt đầu: ${escapeHtml(formatDate(startsAt))} (xếp sau gói hiện tại)`);
  }
  if (expiresAt) lines.push(`Hết hạn: ${escapeHtml(formatDate(expiresAt))}`);
  return lines;
}

export const messages = {
  linked: () => (site) =>
    [header(site, "Đã liên kết Telegram"), "Bạn sẽ nhận thông báo về thanh toán, gói và bảo mật tài khoản tại đây.", "Tuỳ chỉnh loại thông báo trong trang Tài khoản."].join("\n"),
  test: () => (site) => [header(site, "Tin nhắn thử"), "Thông báo Telegram đang hoạt động."].join("\n"),
  orderApproved: (plan) => (site) =>
    [header(site, "Thanh toán thành công"), ...planLines(plan), "Gói đã được kích hoạt cho tài khoản của bạn."].join("\n"),
  planGranted: (plan) => (site) =>
    [header(site, "Bạn được tặng gói"), ...planLines(plan)].join("\n"),
  giftRedeemed: (plan) => (site) =>
    [header(site, "Nhận quà thành công"), ...planLines(plan)].join("\n"),
  planExpiring: ({ planName, expiresAt, daysLeft }) => (site) =>
    [
      header(site, daysLeft <= 1 ? "Gói hết hạn trong 24 giờ" : `Gói sắp hết hạn (${daysLeft} ngày)`),
      planName ? `Gói: <b>${escapeHtml(planName)}</b>` : null,
      `Hết hạn: ${escapeHtml(formatDate(expiresAt))}`,
      "Gia hạn trong trang Tài khoản để không bị gián đoạn.",
    ].filter(Boolean).join("\n"),
  creditLow: ({ planName, remainingNanoUsd, totalNanoUsd }) => (site) =>
    [
      header(site, remainingNanoUsd > 0 ? "Credit sắp hết" : "Đã dùng hết credit"),
      planName ? `Gói: <b>${escapeHtml(planName)}</b>` : null,
      `Còn lại: <code>${escapeHtml(fmtCreditNano(remainingNanoUsd))}</code> / ${escapeHtml(fmtCreditNano(totalNanoUsd))}`,
      "Mua thêm hoặc nạp thêm trong trang Tài khoản.",
    ].filter(Boolean).join("\n"),
  login: ({ ip, userAgent, newIp = false }) => (site) =>
    [
      header(site, newIp ? "Đăng nhập từ địa chỉ mới" : "Đăng nhập tài khoản"),
      ip ? `IP: <code>${escapeHtml(ip)}</code>${newIp ? " (chưa từng đăng nhập từ IP này)" : ""}` : "IP: không rõ",
      userAgent ? `Thiết bị: ${escapeHtml(describeUserAgent(userAgent))}` : null,
      `Lúc: ${escapeHtml(formatDate(new Date().toISOString()))}`,
      "Không phải bạn? Đổi mật khẩu ngay.",
    ].filter(Boolean).join("\n"),
  passwordChanged: ({ reset = false } = {}) => (site) =>
    [
      header(site, reset ? "Mật khẩu đã được đặt lại" : "Mật khẩu đã thay đổi"),
      `Lúc: ${escapeHtml(formatDate(new Date().toISOString()))}`,
      "Các phiên đăng nhập khác đã bị đăng xuất. Không phải bạn? Liên hệ hỗ trợ ngay.",
    ].join("\n"),
  emailChangeRequested: ({ newEmail }) => (site) =>
    [
      header(site, "Yêu cầu đổi email đăng nhập"),
      `Email mới: <code>${escapeHtml(newEmail)}</code>`,
      `Lúc: ${escapeHtml(formatDate(new Date().toISOString()))}`,
      "Email chỉ đổi khi liên kết gửi tới địa chỉ mới được mở. Không phải bạn? Đổi mật khẩu ngay.",
    ].join("\n"),
  emailChanged: ({ newEmail }) => (site) =>
    [
      header(site, "Email đăng nhập đã thay đổi"),
      `Email mới: <code>${escapeHtml(newEmail)}</code>`,
      `Lúc: ${escapeHtml(formatDate(new Date().toISOString()))}`,
      "Không phải bạn? Liên hệ hỗ trợ ngay.",
    ].join("\n"),
  apiKeyCreated: ({ name }) => (site) =>
    [
      header(site, "API key mới được tạo"),
      name ? `Tên: <b>${escapeHtml(name)}</b>` : null,
      `Lúc: ${escapeHtml(formatDate(new Date().toISOString()))}`,
      "Không phải bạn? Xoá key và đổi mật khẩu ngay.",
    ].filter(Boolean).join("\n"),
  telegramUnlinkedByAdmin: () => (site) =>
    [
      header(site, "Đã gỡ liên kết Telegram"),
      "Quản trị viên đã gỡ liên kết giữa tài khoản Telegram này và tài khoản của bạn. Bạn sẽ không nhận thông báo ở đây nữa.",
      "Có thể liên kết lại trong trang Tài khoản. Cần hỗ trợ? Liên hệ quản trị viên.",
    ].join("\n"),
  accountSuspended: () => (site) =>
    [header(site, "Tài khoản bị tạm khoá"), "Liên hệ hỗ trợ nếu bạn cần biết thêm."].join("\n"),
  accountReactivated: () => (site) =>
    [header(site, "Tài khoản đã được mở khoá"), "Bạn có thể đăng nhập lại."].join("\n"),
  broadcast: (text) => (site) => [header(site, "Thông báo"), escapeHtml(text)].join("\n"),
};

// ── Event helpers (read what the message needs, then notify) ─────────────────

/** Plans created for one order, folded into one summary (several periods → one message). */
export function planSummaryForOrderSync(db, orderId) {
  const rows = db.all(
    `SELECT up.creditTotalNanoUsd, up.unlimitedCredit, up.startsAt, up.expiresAt, up.userId, p.name AS planName
       FROM userPlans up LEFT JOIN plans p ON p.id = up.planId
      WHERE up.orderId = ? ORDER BY up.startsAt`,
    [orderId]
  );
  if (!rows.length) return null;
  return {
    userId: rows[0].userId,
    planName: rows[0].planName,
    unlimitedCredit: rows.some((row) => row.unlimitedCredit),
    creditNanoUsd: rows.reduce((sum, row) => sum + (Number(row.creditTotalNanoUsd) || 0), 0),
    startsAt: rows[0].startsAt,
    expiresAt: rows[rows.length - 1].expiresAt,
  };
}

export function planSummaryForUserPlanSync(db, userPlanId) {
  const row = db.get(
    `SELECT up.userId, up.creditTotalNanoUsd, up.unlimitedCredit, up.startsAt, up.expiresAt, p.name AS planName
       FROM userPlans up LEFT JOIN plans p ON p.id = up.planId WHERE up.id = ?`,
    [userPlanId]
  );
  if (!row) return null;
  return {
    userId: row.userId,
    planName: row.planName,
    unlimitedCredit: Boolean(row.unlimitedCredit),
    creditNanoUsd: Number(row.creditTotalNanoUsd) || 0,
    startsAt: row.startsAt,
    expiresAt: row.expiresAt,
  };
}

/** An order was approved (admin, gateway webhook, poller, manual match). */
export async function notifyOrderApproved(orderId) {
  try {
    const db = await getAdapter();
    const plan = planSummaryForOrderSync(db, orderId);
    if (!plan) return { ok: false, reason: "no_plan" };
    return await notifyCustomer(plan.userId, "billing", messages.orderApproved(plan));
  } catch (error) {
    console.error(`[notify] order notification skipped: ${error?.message || "unknown error"}`);
    return { ok: false, reason: "error" };
  }
}

/** A plan or credit landed on the account without an order (gift, admin grant). */
export async function notifyPlanReceived(userPlanId, kind = "gift") {
  try {
    const db = await getAdapter();
    const plan = planSummaryForUserPlanSync(db, userPlanId);
    if (!plan) return { ok: false, reason: "no_plan" };
    const build = kind === "admin" ? messages.planGranted(plan) : messages.giftRedeemed(plan);
    return await notifyCustomer(plan.userId, "billing", build);
  } catch (error) {
    console.error(`[notify] plan notification skipped: ${error?.message || "unknown error"}`);
    return { ok: false, reason: "error" };
  }
}

/** How long a repeat login from the same IP stays silent. */
export const LOGIN_ALERT_QUIET_MS = 15 * 60 * 1000;

/**
 * True when the account already signed in from `ip` within the quiet window.
 * Call BEFORE recording the current login. A missing IP compares as "unknown".
 */
export function recentLoginFromIpSync(db, userId, ip, { now = Date.now(), windowMs = LOGIN_ALERT_QUIET_MS } = {}) {
  if (!userId) return false;
  const since = new Date(now - windowMs).toISOString();
  const row = ip
    ? db.get(
        `SELECT 1 AS x FROM activityLog WHERE userId = ? AND action = 'login' AND ip = ? AND createdAt >= ? LIMIT 1`,
        [userId, ip, since]
      )
    : db.get(
        `SELECT 1 AS x FROM activityLog WHERE userId = ? AND action = 'login' AND ip IS NULL AND createdAt >= ? LIMIT 1`,
        [userId, since]
      );
  return Boolean(row);
}

/** Text of the admin-chat alert for a dashboard sign-in (sent by notify/telegram.js). */
export function adminLoginText({ method = "password", ip = null, userAgent = null, identity = null } = {}) {
  const methodLabel = { password: "mật khẩu", oidc: "OIDC", saml: "SAML" }[method] || method;
  const lines = ["<b>Đăng nhập admin</b>"];
  if (identity) lines.push(`tài khoản: <code>${escapeHtml(identity)}</code>`);
  lines.push(`cách: ${escapeHtml(methodLabel)}`);
  lines.push(`IP: <code>${escapeHtml(ip || "không rõ")}</code>`);
  if (userAgent) lines.push(`thiết bị: ${escapeHtml(describeUserAgent(userAgent))}`);
  lines.push(`lúc: ${escapeHtml(formatDate(new Date().toISOString()))}`);
  return lines.join("\n");
}

/** Admin gave a gift code to accounts: tell each one that received it, one after another. */
export async function notifyGiftAssignments(results) {
  for (const item of Array.isArray(results) ? results : []) {
    if (item?.ok && item.userPlanId) await notifyPlanReceived(item.userPlanId, "gift");
  }
}

/**
 * True when `ip` never appeared on a successful login of this account. Call
 * BEFORE recording the current login. No IP (untrusted proxy setup) or no earlier
 * login at all (first sign-in) → false: nothing meaningful to warn about.
 */
export function isNewLoginIpSync(db, userId, ip) {
  if (!userId || !ip) return false;
  const any = db.get(`SELECT 1 AS x FROM activityLog WHERE userId = ? AND action = 'login' LIMIT 1`, [userId]);
  if (!any) return false;
  const seen = db.get(
    `SELECT 1 AS x FROM activityLog WHERE userId = ? AND action IN ('login', 'register') AND ip = ? LIMIT 1`,
    [userId, ip]
  );
  return !seen;
}
