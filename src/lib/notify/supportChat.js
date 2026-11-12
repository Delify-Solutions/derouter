// Two-way support chat over the same bot that sends notifications
// (spec telegram-support).
//
// A linked customer types in the bot chat; the bot relays that text to the admin
// chat. The admin answers with Telegram's native reply on the relayed message, and
// the bot delivers that answer back to the customer. No admin UI is required: the
// admin chat IS the inbox, so an operator answers from the phone.
//
// The customer never needs a web session: their side of the conversation is the bot
// chat itself, which Telegram authenticated when it handed us the update.
//
// Relative imports only: tests import this module directly.

import crypto from "node:crypto";
import { getAdapter } from "../db/driver.js";
import { getSettings } from "../db/repos/settingsRepo.js";
import { getMeta, setMeta } from "../db/helpers/metaStore.js";
import { checkLimits } from "../auth/actionLimiter.js";
import {
  MAX_MESSAGE_LENGTH,
  escapeHtml,
  getTelegramUpdates,
  sendTelegramChatAction,
  sendTelegramMessage,
} from "./telegramApi.js";

/**
 * Commands that open the chat instead of being relayed. `/start` is included
 * because every route into the bot ends up there: the account page links
 * `?start=help`, and Telegram turns that into the message "/start help".
 */
export const HELP_COMMANDS = ["/start", "/help", "/hotro", "/hỗ trợ"];

/** Offset of the update stream, shared by every caller so two ticks cannot overlap. */
const OFFSET_META_KEY = "telegramSupportOffset";
/** Long-poll window handed to Telegram. The loop stops when this returns. */
export const LONG_POLL_SEC = 25;
/** A message longer than this is refused rather than silently cut. */
export const MAX_INBOUND_LENGTH = MAX_MESSAGE_LENGTH;
/**
 * Inbound messages allowed per Telegram user per window. Without this a customer (or
 * a script holding their chat) can flood the bot, and the bot's OWN token takes the
 * flood limit from Telegram — which would silence notifications for every customer
 * until it clears.
 */
export const INBOUND_LIMIT = { limit: 20, windowMs: 10 * 60 * 1000 };

const g = (globalThis.__telegramSupport ??= { running: false, abort: null, lastError: null });

// ── Config ────────────────────────────────────────────────────────────────────

async function loadConfig() {
  let settings = {};
  try {
    settings = (await getSettings()) || {};
  } catch {
    settings = {};
  }
  const token = typeof settings.telegramBotToken === "string" ? settings.telegramBotToken.trim() : "";
  const adminChatId = typeof settings.telegramChatId === "string" ? settings.telegramChatId.trim() : "";
  const siteName = typeof settings.siteName === "string" && settings.siteName.trim() ? settings.siteName.trim() : "derouter";
  return { token, adminChatId, siteName, configured: Boolean(token) };
}

/** `https://t.me/<bot>?start=help`, or null when no bot username is set. */
export async function supportBotUrl() {
  const settings = await getSettings().catch(() => ({}));
  const username = String(settings?.telegramBotUsername || "").trim().replace(/^@/, "");
  return /^[A-Za-z0-9_]{3,64}$/.test(username) ? `https://t.me/${username}?start=help` : null;
}

// ── Storage ───────────────────────────────────────────────────────────────────

/**
 * The account behind a Telegram user id, when that account is linked and active.
 * `status` is carried so the caller can answer a suspended account instead of
 * silently dropping the message.
 */
export function resolveChatUserSync(db, telegramUserId) {
  const row = db.get(
    `SELECT id, email, displayName, status, telegramUserId, telegramUsername
       FROM users WHERE telegramUserId = ?`,
    [String(telegramUserId)]
  );
  return row
    ? {
        userId: row.id,
        email: row.email,
        displayName: row.displayName,
        status: row.status,
        telegramUsername: row.telegramUsername,
      }
    : null;
}

/**
 * Store one message. Inbound is idempotent on (userId, telegramMessageId): Telegram
 * re-delivers an update whose offset was not confirmed, and a repeated customer
 * message must not appear twice.
 *
 * @returns {{ stored: boolean, id?: string }}
 */
export function insertSupportMessageSync(db, {
  userId,
  direction,
  body,
  telegramMessageId = null,
  createdBy = null,
  createdAt = null,
}) {
  if (!userId || !direction || !body) return { stored: false };
  if (telegramMessageId != null) {
    // Scoped by direction: the customer's chat and the admin chat number their
    // messages independently, so id 50 exists on both sides.
    const seen = db.get(
      `SELECT id FROM supportMessages WHERE userId = ? AND direction = ? AND telegramMessageId = ?`,
      [userId, direction, Number(telegramMessageId)]
    );
    if (seen) return { stored: false, id: seen.id };
  }
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO supportMessages(id, userId, direction, body, telegramMessageId, createdBy, createdAt, readAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, NULL)`,
    [id, userId, direction, String(body).slice(0, MAX_MESSAGE_LENGTH), telegramMessageId, createdBy, createdAt || new Date().toISOString()]
  );
  return { stored: true, id };
}

/** One page of an account's conversation, oldest first (it reads top to bottom). */
export function listSupportMessagesSync(db, userId, { limit = 100 } = {}) {
  const take = Math.min(Math.max(1, Math.floor(Number(limit) || 100)), 500);
  // Ordered by `rowid`, not by `id` (a random uuid) or `createdAt` alone: two
  // messages sent in the same millisecond must still read in the order they
  // arrived, or a conversation would render out of order.
  const rows = db.all(
    `SELECT id, direction, body, createdBy, createdAt, readAt
       FROM supportMessages WHERE userId = ? ORDER BY rowid DESC LIMIT ?`,
    [userId, take]
  );
  return rows.reverse().map((row) => ({
    id: row.id,
    direction: row.direction,
    body: row.body,
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt,
    readAt: row.readAt ?? null,
  }));
}

/**
 * Accounts with a conversation, newest message first, with the unread count of
 * customer messages an admin has not opened yet.
 */
export function listSupportThreadsSync(db, { limit = 50 } = {}) {
  const take = Math.min(Math.max(1, Math.floor(Number(limit) || 50)), 200);
  const rows = db.all(
    `SELECT s.userId,
            (SELECT createdAt FROM supportMessages x
              WHERE x.userId = s.userId ORDER BY x.rowid DESC LIMIT 1) AS lastAt,
            COUNT(*) AS total,
            SUM(CASE WHEN s.direction = 'in' AND s.readAt IS NULL THEN 1 ELSE 0 END) AS unread,
            (SELECT body FROM supportMessages x
              WHERE x.userId = s.userId ORDER BY x.rowid DESC LIMIT 1) AS lastBody,
            (SELECT direction FROM supportMessages x
              WHERE x.userId = s.userId ORDER BY x.rowid DESC LIMIT 1) AS lastDirection,
            u.email, u.displayName, u.status, u.telegramUsername
       FROM supportMessages s
       LEFT JOIN users u ON u.id = s.userId
      GROUP BY s.userId
      ORDER BY lastAt DESC
      LIMIT ?`,
    [take]
  );
  return rows.map((row) => ({
    userId: row.userId,
    email: row.email ?? null,
    displayName: row.displayName ?? null,
    status: row.status ?? null,
    telegramUsername: row.telegramUsername ?? null,
    lastAt: row.lastAt,
    total: Number(row.total) || 0,
    unread: Number(row.unread) || 0,
    lastBody: row.lastBody ?? "",
    lastDirection: row.lastDirection ?? "in",
  }));
}

/** Mark every customer message of `userId` as seen. Returns how many changed. */
export function markSupportReadSync(db, userId, now = null) {
  const res = db.run(
    `UPDATE supportMessages SET readAt = ? WHERE userId = ? AND direction = 'in' AND readAt IS NULL`,
    [now || new Date().toISOString(), userId]
  );
  return res?.changes ?? 0;
}

// ── Inbound (customer → admin) ────────────────────────────────────────────────

/**
 * Turn one Telegram update into a stored message and an admin relay.
 *
 * Only three things are acted on: a command from a customer (`/help`), free text
 * from a customer, and a reply from the admin chat. Everything else is ignored,
 * because a bot that echoes arbitrary updates is a spam amplifier.
 *
 * @returns {Promise<{ handled: string }>} "command" | "customer" | "admin_reply" | "ignored"
 */
export async function handleSupportUpdate(db, update, { config = null, send = sendTelegramMessage, typing = sendTelegramChatAction } = {}) {
  const message = update?.message;
  if (!message) return { handled: "ignored" };

  const cfg = config || (await loadConfig());
  if (!cfg.token) return { handled: "ignored" };

  const chatId = String(message.chat?.id ?? "");
  const fromId = String(message.from?.id ?? "");
  const text = typeof message.text === "string" ? message.text.trim() : "";
  if (!chatId || !fromId) return { handled: "ignored" };

  // The admin chat is very often a GROUP (the notification chat id is configured as
  // `-100…`), so the "private only" rule below must not apply to it. That rule keeps
  // a bot added to some unrelated group from relaying its members' chatter.
  const isAdminChat = Boolean(cfg.adminChatId) && chatId === cfg.adminChatId;
  if (!isAdminChat && message.chat?.type && message.chat.type !== "private") return { handled: "ignored" };

  if (isAdminChat) {
    // The admin's reply on a relayed message is the answer to that customer.
    const repliedTo = Number(message.reply_to_message?.message_id);
    const target = Number.isFinite(repliedTo) ? findSupportTargetByTelegramIdSync(db, repliedTo) : null;
    if (!target) return { handled: "ignored" };
    return await deliverAdminReply(db, { target, text, message, send, typing });
  }

  const user = resolveChatUserSync(db, fromId);
  if (!user) {
    // Someone found the bot without linking an account. Tell them how, once per
    // message — this is the only reply an unlinked chat ever gets.
    await send(cfg.token, chatId, [
      `<b>${escapeHtml(cfg.siteName)}</b> · Chưa liên kết tài khoản`,
      "Telegram này chưa gắn với tài khoản nào.",
      "Vào mục Tài khoản trên trang web và bấm \"Liên kết Telegram\", rồi nhắn lại.",
    ].join("\n"));
    return { handled: "command" };
  }

  // An attachment is not forwarded (downloading arbitrary files from a bot chat is an
  // attack surface this feature does not need), but silence would look like a broken
  // bot. Say so, once, and only in a customer's private chat.
  if (!text) {
    if (!isAdminChat) {
      await send(cfg.token, chatId, "Hiện chỉ nhận tin nhắn dạng chữ. Bạn mô tả hoặc dán nội dung lỗi giúp nhé.");
    }
    return { handled: "ignored" };
  }

  if (isHelpCommand(text)) {
    // A command is not part of the conversation: storing it would put "/help" in the
    // admin's thread and count it as an unread message the admin has to open.
    await send(cfg.token, chatId, [
      `<b>${escapeHtml(cfg.siteName)}</b> · Hỗ trợ`,
      "Nhắn nội dung bạn cần hỗ trợ ngay trong khung chat này, admin sẽ nhận được và trả lời tại đây.",
      "Có thể gửi nhiều tin liên tiếp; tin nào cũng tới.",
    ].join("\n"));
    return { handled: "command" };
  }

  if (text.length > MAX_INBOUND_LENGTH) {
    await send(cfg.token, chatId, `Tin nhắn dài quá ${MAX_INBOUND_LENGTH} ký tự, bạn chia nhỏ giúp nhé.`);
    return { handled: "command" };
  }
  if (user.status !== "active") {
    await send(cfg.token, chatId, "Tài khoản đang bị tạm khoá nên chat hỗ trợ chưa dùng được. Liên hệ admin qua kênh khác.");
    return { handled: "command" };
  }

  // Idempotency first: a re-delivered update must not be relayed twice, and it must
  // not be stored before we know it is new. A re-delivery is not the customer asking
  // again, so it must not spend their rate budget either.
  if (alreadyStoredSync(db, user.userId, message.message_id)) return { handled: "ignored" };

  // Flooding the bot spends the BOT's own Telegram quota, which would silence every
  // customer's notifications. Cap one customer's chatter before relaying anything.
  const gate = checkLimits([{ bucket: `support:tg:${fromId}`, ...INBOUND_LIMIT }]);
  if (!gate.allowed) {
    await send(cfg.token, chatId, [
      "Bạn đã gửi khá nhiều tin. Chờ vài phút rồi nhắn tiếp giúp mình nhé.",
      `Tin trước đó đã tới admin, không cần gửi lại.`,
    ].join("\n"));
    return { handled: "command" };
  }

  const relayed = await relayToAdmin(db, cfg, { user, text, send, siteName: cfg.siteName });
  if (!relayed?.ok) {
    // Never tell a customer their message was delivered when it was not. Nothing is
    // stored either, so the conversation shows only what actually reached the admin.
    await send(cfg.token, chatId, [
      "Chưa gửi được tới admin. Bạn thử lại giúp nhé.",
      // An unconfigured admin chat is an operator problem, not something the customer
      // can fix by retrying — say so instead of asking them to try again forever.
      relayed?.reason === "not_configured" ? "Kênh hỗ trợ đang được cấu hình." : null,
    ].filter(Boolean).join("\n"));
    return { handled: "command" };
  }

  insertSupportMessageSync(db, {
    userId: user.userId,
    direction: "in",
    body: text,
    telegramMessageId: message.message_id,
  });
  // Acknowledge in the customer's chat so they know it left their phone.
  await typing(cfg.token, chatId, "typing");
  await send(cfg.token, chatId, "Đã gửi tới admin. Trả lời sẽ hiện ngay tại đây.");
  return { handled: "customer" };
}

/** Has this inbound update already been handled? Read-only; nothing is written. */
function alreadyStoredSync(db, userId, telegramMessageId) {
  if (telegramMessageId == null) return false;
  return Boolean(
    db.get(
      `SELECT 1 AS hit FROM supportMessages
        WHERE userId = ? AND direction = 'in' AND telegramMessageId = ?`,
      [userId, Number(telegramMessageId)]
    )
  );
}

export function isHelpCommand(text) {
  // "/help@some_bot" is how a command arrives when it is sent in a group; strip the
  // suffix so the same commands work either way.
  const first = String(text || "").trim().split(/\s+/)[0]?.toLowerCase().split("@")[0];
  return HELP_COMMANDS.includes(first);
}

function maskEmailLocal(email) {
  const value = String(email || "");
  const at = value.indexOf("@");
  if (at <= 0) return "***";
  return `${value[0]}***${value.slice(at)}`;
}

/**
 * Send the customer's message to the admin chat. The relay carries the account so
 * the admin knows who is talking without opening the dashboard, and the admin
 * answers by replying to THIS message.
 */
async function relayToAdmin(db, cfg, { user, text, send, siteName }) {
  if (!cfg.adminChatId) return { ok: false, reason: "not_configured" };
  const who = user.displayName ? `${user.displayName} (${maskEmailLocal(user.email)})` : maskEmailLocal(user.email);
  const body = [
    `<b>${escapeHtml(siteName)}</b> · Tin nhắn hỗ trợ`,
    `Khách: <b>${escapeHtml(who)}</b>`,
    user.telegramUsername ? `Telegram: @${escapeHtml(user.telegramUsername)}` : null,
    "──────────",
    escapeHtml(text),
    "──────────",
    "Trả lời bằng cách <b>Reply</b> chính tin này.",
  ].filter(Boolean).join("\n");

  const result = await send(cfg.token, cfg.adminChatId, body);
  // Remember which admin-chat message stands for this customer, so the admin's
  // reply can be routed back even much later.
  if (result?.ok && result.messageId) {
    db.run(
      `INSERT OR REPLACE INTO kv(scope, key, value) VALUES('telegramSupportRelay', ?, ?)`,
      [String(result.messageId), user.userId]
    );
  }
  return result;
}

/** Which account an admin-chat message stands for (a relay sent earlier). */
export function findSupportTargetByTelegramIdSync(db, telegramMessageId) {
  const row = db.get(
    `SELECT value FROM kv WHERE scope = 'telegramSupportRelay' AND key = ?`,
    [String(Number(telegramMessageId))]
  );
  if (!row?.value) return null;
  const user = db.get(`SELECT id, email, telegramUserId FROM users WHERE id = ?`, [row.value]);
  return user?.telegramUserId ? { userId: user.id, telegramUserId: user.telegramUserId, email: user.email } : null;
}

// ── Outbound (admin → customer) ───────────────────────────────────────────────

/** Deliver an admin answer to the customer's chat and store it. */
async function deliverAdminReply(db, { target, text, message, send, typing }) {
  const cfg = await loadConfig();
  if (!cfg.token) return { handled: "ignored" };
  if (text.length > MAX_INBOUND_LENGTH) return { handled: "ignored" };

  await typing(cfg.token, target.telegramUserId, "typing");
  const result = await send(cfg.token, target.telegramUserId, escapeHtml(text));
  // Only a DELIVERED answer joins the conversation. Storing a failed one would show
  // the admin a message the customer never received.
  if (result?.ok) {
    insertSupportMessageSync(db, {
      userId: target.userId,
      direction: "out",
      body: text,
      telegramMessageId: message?.message_id ?? null,
      createdBy: "telegram:admin",
    });
    // A delivered answer clears the "bot cannot reach this customer" marker, the
    // same way any other successful message does.
    db.run(`UPDATE users SET telegramDmBlockedAt = NULL WHERE id = ? AND telegramUserId = ?`, [
      target.userId,
      target.telegramUserId,
    ]);
  } else {
    if (result?.blocked) {
      db.run(`UPDATE users SET telegramDmBlockedAt = ? WHERE id = ? AND telegramUserId = ?`, [
        new Date().toISOString(),
        target.userId,
        target.telegramUserId,
      ]);
    }
    // The admin typed something and must learn it did not arrive, whatever the reason
    // (blocked, flood limit, Telegram down). Silence here means the admin believes the
    // customer was answered.
    if (cfg.adminChatId) {
      const why = result?.blocked
        ? "bot đã bị chặn hoặc chat không tồn tại"
        : result?.reason === "rate_limited"
          ? "Telegram giới hạn tốc độ, thử lại sau ít phút"
          : result?.reason === "not_configured"
            ? "chưa cấu hình bot token"
            : "lỗi kết nối Telegram";
      await send(cfg.token, cfg.adminChatId, `Không gửi được cho khách: ${why}. Tin chưa tới nơi và không được lưu.`);
    }
  }
  return { handled: result?.ok ? "admin_reply" : "ignored" };
}

/**
 * Send an admin's reply from the dashboard (the second way to answer, for when the
 * operator is at a computer). Same delivery and storage as the Telegram reply.
 *
 * @returns {Promise<{ ok: boolean, reason?: string, messageId?: string }>}
 */
export async function replyToCustomer({ userId, text, createdBy = "admin", send = sendTelegramMessage }) {
  const body = String(text ?? "").trim();
  if (!userId || !body) return { ok: false, reason: "invalid" };
  if (body.length > MAX_INBOUND_LENGTH) return { ok: false, reason: "too_long" };

  const cfg = await loadConfig();
  if (!cfg.token) return { ok: false, reason: "not_configured" };
  const db = await getAdapter();
  const user = db.get(`SELECT id, telegramUserId, telegramDmBlockedAt FROM users WHERE id = ?`, [userId]);
  if (!user?.telegramUserId) return { ok: false, reason: "not_linked" };

  const result = await send(cfg.token, user.telegramUserId, escapeHtml(body));
  // Undelivered answers are not part of the conversation: the dashboard reports the
  // failure instead of showing a message the customer never got.
  if (!result?.ok) {
    if (result?.blocked) {
      db.run(`UPDATE users SET telegramDmBlockedAt = ? WHERE id = ? AND telegramUserId = ?`, [
        new Date().toISOString(),
        userId,
        user.telegramUserId,
      ]);
    }
    return { ok: false, reason: result?.reason || "telegram_error" };
  }
  const stored = insertSupportMessageSync(db, {
    userId,
    direction: "out",
    body,
    createdBy,
  });
  db.run(`UPDATE users SET telegramDmBlockedAt = NULL WHERE id = ? AND telegramUserId = ?`, [userId, user.telegramUserId]);
  return { ok: true, messageId: stored.stored ? stored.id : null };
}

// ── Loop ──────────────────────────────────────────────────────────────────────

/**
 * Read one batch of updates and handle it. The offset is persisted BEFORE the
 * batch is handled, so a crash mid-batch loses at most that batch rather than
 * replaying everything: a support chat would rather drop one message than deliver
 * it three times.
 *
 * @returns {Promise<{ ok: boolean, handled: number, offset: number, reason?: string }>}
 */
export async function pollSupportUpdatesOnce({
  getUpdates = getTelegramUpdates,
  send = sendTelegramMessage,
  typing = sendTelegramChatAction,
  timeoutSec = 0,
  signal = null,
} = {}) {
  const cfg = await loadConfig();
  if (!cfg.token) return { ok: false, handled: 0, offset: 0, reason: "not_configured" };

  const offset = Number(await getMeta(OFFSET_META_KEY, "0")) || 0;
  const batch = await getUpdates(cfg.token, { offset, timeoutSec, signal });
  if (!batch.ok) return { ok: false, handled: 0, offset, reason: batch.reason };

  if (batch.offset !== offset) await setMeta(OFFSET_META_KEY, String(batch.offset));

  const db = await getAdapter();
  let handled = 0;
  for (const update of batch.updates || []) {
    try {
      const outcome = await handleSupportUpdate(db, update, { config: cfg, send, typing });
      if (outcome.handled !== "ignored") handled += 1;
    } catch (error) {
      // One malformed update must not stop the stream.
      console.warn(`[SupportChat] update skipped: ${error?.message || "unknown error"}`);
    }
  }
  return { ok: true, handled, offset: batch.offset };
}

function isTruthyEnv(value) {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Start long polling. Idempotent, and skipped during a build.
 * `DISABLE_TELEGRAM_SUPPORT` turns it off; a deployment that also sets a webhook
 * must not start this (Telegram allows only one reader, and getUpdates answers 409).
 */
export function startSupportChat() {
  if (g.running) return false;
  if (isTruthyEnv(process.env.DISABLE_TELEGRAM_SUPPORT)) return false;
  if (process.env.NEXT_PHASE === "phase-production-build") return false;

  g.running = true;
  const loop = async () => {
    while (g.running) {
      try {
        const controller = new AbortController();
        g.abort = controller;
        const result = await pollSupportUpdatesOnce({ timeoutSec: LONG_POLL_SEC, signal: controller.signal });
        g.lastError = result.ok ? null : result.reason;
        // No bot configured, or the token is wrong: nothing works until an operator
        // saves settings, and a tight loop would only spin and spam Telegram.
        if (result.reason === "not_configured" || result.reason === "invalid_token") await sleep(60_000);
        // 409 means a webhook or another instance owns the stream: stop hammering.
        else if (result.reason === "conflict") await sleep(120_000);
        else if (!result.ok) await sleep(5_000);
      } catch (error) {
        g.lastError = error?.message || String(error);
        console.warn("[SupportChat] loop error (swallowed):", g.lastError);
        await sleep(5_000);
      } finally {
        g.abort = null;
      }
    }
  };
  loop().catch((error) => {
    console.error("[SupportChat] loop stopped:", error?.message || "unknown error");
    g.running = false;
  });
  return true;
}

export function stopSupportChat() {
  if (!g.running) return false;
  g.running = false;
  try {
    g.abort?.abort();
  } catch {
    /* ignore */
  }
  g.abort = null;
  return true;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function supportChatStatusForTests() {
  return { running: g.running, lastError: g.lastError };
}
