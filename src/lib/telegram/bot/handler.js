// Telegram bot update dispatcher (change telegram-bot-commands).
//
// One update in, replies out through `api` ({ send, edit, answer }). Private
// chats only; groups and channels are ignored. Who is writing is Telegram's
// `from.id` (the webhook secret proves the update came from Telegram): the
// customer is the account linked to it, an admin is an id listed in settings.
// Admin commands are invisible to everyone else (answered as unknown).
//
// Relative imports only: tests import this module directly.
import {
  mainMenu, helpText, notLinkedReply, meReply, usageReply, plansReply, keysReply, settingsReply, togglePref,
  unlinkAsk, unlinkDo, giftsReply, redeemReply,
} from "./customer.js";
import { isAdmin, statsReply, ordersReply, orderConfirmReply, approveDo, cancelDo, userReply } from "./admin.js";
import { escapeHtml } from "./format.js";

/** "/gift@MyBot abc" → { command: "gift", arg: "abc" }; null when not a command. */
export function parseCommand(text) {
  const m = String(text || "").trim().match(/^\/([a-zA-Z0-9_]{1,32})(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  return { command: m[1].toLowerCase(), arg: (m[2] || "").trim() };
}

const CUSTOMER = new Set(["me", "balance", "usage", "gifts", "gift", "plans", "keys", "settings", "unlink"]);
const ADMIN = new Set(["stats", "orders", "user"]);

function findCustomerSync(db, telegramUserId) {
  return db.get(
    `SELECT id, email, status, groupId, displayName FROM users WHERE telegramUserId = ?`,
    [String(telegramUserId)]
  ) || null;
}

/** The reply for a command (also used by the menu buttons). */
async function commandReply(command, arg, ctx) {
  const { user, admin } = ctx;
  // Anyone: their own Telegram id, which the admin needs to list themselves.
  if (command === "id") {
    return { text: `Telegram ID của bạn: <code>${escapeHtml(String(ctx.from.id))}</code>`, markup: null };
  }
  if (command === "start" || command === "help" || command === "menu") {
    if (!user && !admin) return notLinkedReply(ctx.baseUrl);
    return { text: helpText(ctx.siteName, { admin }), markup: user ? mainMenu() : null };
  }
  if (ADMIN.has(command)) {
    if (!admin) return { text: "Không có lệnh này. Gõ /help để xem các lệnh.", markup: null };
    if (command === "stats") return statsReply(ctx);
    if (command === "orders") return ordersReply(ctx);
    return userReply(ctx, arg);
  }
  if (CUSTOMER.has(command)) {
    if (!user) return notLinkedReply(ctx.baseUrl);
    if (user.status === "suspended") return { text: "Tài khoản đang bị khoá. Vui lòng liên hệ hỗ trợ.", markup: null };
    switch (command) {
      case "me":
      case "balance": return meReply(ctx);
      case "usage": return usageReply(ctx);
      case "gifts": return giftsReply(ctx);
      case "gift": return arg ? redeemReply(ctx, arg) : giftsReply(ctx);
      case "plans": return plansReply(ctx);
      case "keys": return keysReply(ctx);
      case "settings": return settingsReply(ctx);
      case "unlink": return unlinkAsk();
      default: break;
    }
  }
  return { text: "Không có lệnh này. Gõ /help để xem các lệnh.", markup: null };
}

/** The reply for a button press; `mode` "edit" replaces the pressed message, "send" adds one. */
async function callbackReply(data, ctx) {
  const [kind, value = ""] = String(data || "").split(/:(.*)/s);
  const { user, admin } = ctx;
  if (kind === "m") return { mode: "edit", ...(await commandReply(value, "", ctx)) };
  if (kind === "a" || kind === "oa" || kind === "oc" || kind === "oy" || kind === "ox") {
    if (!admin) return { mode: "edit", text: "Không có quyền.", markup: null };
    if (kind === "a") return { mode: "edit", ...(await ordersReply(ctx)) };
    if (kind === "oa") return { mode: "edit", ...(await orderConfirmReply(value, "approve")) };
    if (kind === "oc") return { mode: "edit", ...(await orderConfirmReply(value, "cancel")) };
    if (kind === "oy") return { mode: "edit", ...(await approveDo(ctx, value)) };
    return { mode: "edit", ...(await cancelDo(ctx, value)) };
  }
  if (!user) return { mode: "edit", ...notLinkedReply(ctx.baseUrl) };
  if (user.status === "suspended") return { mode: "edit", text: "Tài khoản đang bị khoá. Vui lòng liên hệ hỗ trợ.", markup: null };
  if (kind === "g") return { mode: "send", ...(await redeemReply(ctx, value)) };
  if (kind === "n") return { mode: "edit", ...togglePref(ctx, value) };
  if (kind === "u" && value === "ask") return { mode: "edit", ...unlinkAsk() };
  if (kind === "u" && value === "yes") return { mode: "edit", ...unlinkDo(ctx) };
  return { mode: "edit", text: "Nút này đã cũ. Gõ /help để bắt đầu lại.", markup: null };
}

/**
 * Handle one Telegram update. Never throws: a failure answers with a short
 * apology so the customer is not left waiting.
 *
 * @param {object} update  Telegram Update
 * @param {{ db, settings, api, siteName?, baseUrl?, checkMember?, reserve? }} deps
 *   checkMember / reserve: the channel membership check and its spacing (tests).
 * @returns {Promise<{ handled: boolean }>}
 */
export async function handleUpdate(update, deps) {
  const { db, settings = {}, api, siteName = "derouter", baseUrl = "", checkMember, reserve } = deps;
  const message = update?.message;
  const callback = update?.callback_query;
  const chat = message?.chat ?? callback?.message?.chat;
  const from = message?.from ?? callback?.from;
  if (!chat || !from || chat.type !== "private" || from.is_bot) {
    if (callback?.id) await api.answer(callback.id);
    return { handled: false };
  }

  const ctx = {
    db, settings, baseUrl, siteName, from, checkMember, reserve,
    admin: isAdmin(settings, from.id),
    user: null,
  };

  try {
    ctx.user = findCustomerSync(db, from.id);
    if (callback) {
      const reply = await callbackReply(callback.data, ctx);
      await api.answer(callback.id);
      if (reply.mode === "send" || !callback.message?.message_id) {
        await api.send(chat.id, reply.text, reply.markup);
      } else {
        await api.edit(chat.id, callback.message.message_id, reply.text, reply.markup);
      }
      return { handled: true };
    }

    const text = typeof message.text === "string" ? message.text : "";
    const parsed = parseCommand(text);
    if (!parsed) {
      await api.send(chat.id, "Gõ /help để xem các lệnh, hoặc <code>/gift MÃ</code> để nhập mã quà.", ctx.user ? mainMenu() : null);
      return { handled: true };
    }
    const reply = await commandReply(parsed.command, parsed.arg, ctx);
    await api.send(chat.id, reply.text, reply.markup);
    return { handled: true };
  } catch (error) {
    // The message only: no update content (it can hold what the customer typed).
    console.error(`[telegram-bot] update failed: ${String(error?.message || error?.name || "error").slice(0, 200)}`);
    try {
      if (callback?.id) await api.answer(callback.id, "Có lỗi, vui lòng thử lại.");
      await api.send(chat.id, "Có lỗi xảy ra, vui lòng thử lại sau.");
    } catch {
      /* nothing more to do */
    }
    return { handled: false };
  }
}
