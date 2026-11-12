// Text helpers for the command bot (change telegram-bot-commands). Telegram HTML.
// Relative imports only: tests import this module directly.
import { escapeHtml } from "../../notify/telegramApi.js";
import { fmtUsdNano, UNLIMITED_CREDIT_LABEL } from "../../../shared/utils/money.js";
import { formatVnd, formatUsdt } from "../../payments/amounts.js";

export { escapeHtml, fmtUsdNano, formatVnd, UNLIMITED_CREDIT_LABEL };

const DATE = new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", year: "numeric" });
const DATE_TIME = new Intl.DateTimeFormat("vi-VN", {
  timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
});

export function fmtDate(iso) {
  const d = new Date(iso || "");
  return Number.isNaN(d.getTime()) ? "—" : DATE.format(d);
}

export function fmtDateTime(iso) {
  const d = new Date(iso || "");
  return Number.isNaN(d.getTime()) ? "—" : DATE_TIME.format(d);
}

/** Start of today in Vietnam (UTC+7, no DST) as an ISO instant. */
export function vnDayStartIso(now = Date.now(), daysBack = 0) {
  const offset = 7 * 3600 * 1000;
  const local = Math.floor((now + offset) / 86400000) * 86400000;
  return new Date(local - offset - daysBack * 86400000).toISOString();
}

/** What an order costs, in the currency it is paid in. */
export function orderAmountText(order) {
  if (order.payCurrency === "VND" && order.payAmount != null) return formatVnd(order.payAmount);
  if (order.payCurrency === "USDT" && order.payAmount != null) return `${formatUsdt(order.payAmount)} USDT`;
  return fmtUsdNano(order.amountNanoUsd);
}

/** Sum per currency → "1.250.000đ · $12.00". */
export function totalsText(rows) {
  const parts = rows.map((row) => {
    if (row.currency === "VND") return formatVnd(row.total);
    if (row.currency === "USDT") return `${formatUsdt(row.total)} USDT`;
    return fmtUsdNano(row.total);
  });
  return parts.length ? parts.join(" · ") : "0";
}

/** A URL button, only for an https base (Telegram rejects local addresses). */
export function urlButton(text, baseUrl, path) {
  if (!/^https:\/\//i.test(baseUrl || "")) return null;
  return { text, url: `${baseUrl.replace(/\/+$/, "")}${path}` };
}

/** An inline keyboard from rows of buttons, dropping null buttons and empty rows. */
export function keyboard(rows) {
  const clean = rows.map((row) => row.filter(Boolean)).filter((row) => row.length > 0);
  return clean.length ? { inline_keyboard: clean } : null;
}
