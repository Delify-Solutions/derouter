// Two-way support chat over the bot (spec telegram-support).
//
// The behaviours a customer or an admin would notice:
//   * a customer's text reaches the admin chat, once, with enough context to know
//     who wrote it;
//   * the admin's reply on that relayed message comes back to the right customer;
//   * an unlinked chat is told how to link, and nothing is forwarded;
//   * a re-delivered update is not stored or relayed twice;
//   * a suspended account gets an answer instead of silence;
//   * the dashboard can answer through the same path.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-tg-support-"));
// DATA_DIR must be set before the DB driver is imported.
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const { updateSettings } = await import("../src/lib/db/repos/settingsRepo.js");
const { getMeta } = await import("../src/lib/db/helpers/metaStore.js");
const support = await import("../src/lib/notify/supportChat.js");
const { sendTelegramMessage, getTelegramUpdates, MAX_MESSAGE_LENGTH } = await import("../src/lib/notify/telegramApi.js");
const { resetAll: resetLimits } = await import("../src/lib/auth/actionLimiter.js");

let db;
let sent = [];
let nextMessageId = 1000;

/** Fake transport: records what the bot sends, hands back a message id. */
async function fakeSend(token, chatId, text) {
  sent.push({ chatId: String(chatId), text });
  nextMessageId += 1;
  return { ok: true, messageId: nextMessageId };
}
const fakeTyping = async () => ({ ok: true });

const ADMIN_CHAT = "-100999";

before(async () => {
  db = await getAdapter();
  await updateSettings({
    telegramBotToken: "123:test",
    telegramChatId: ADMIN_CHAT,
    telegramBotUsername: "derouter_bot",
    siteName: "derouter",
  });
});

after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  for (const table of ["users", "supportMessages", "kv", "_meta"]) {
    db.run(`DELETE FROM ${table}`);
  }
  db.run(`INSERT INTO _meta(key, value) VALUES('schemaVersion', '0') ON CONFLICT(key) DO NOTHING`);
  sent = [];
  nextMessageId = 1000;
  // The inbound flood guard is process-global; each test starts with a clean budget.
  resetLimits();
});

function user(id, { telegram = null, status = "active", displayName = null } = {}) {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO users(id, email, passwordHash, status, createdAt, updatedAt, telegramUserId, telegramUsername, displayName)
     VALUES(?, ?, 'x', ?, ?, ?, ?, ?, ?)`,
    [id, `${id}@gmail.com`, status, now, now, telegram, telegram ? "khanh" : null, displayName]
  );
  return id;
}

/** One update as Telegram sends it: a private message from `fromId`. */
function update({ updateId = 1, messageId = 501, fromId, chatId = null, text, replyTo = null, chatType = "private" } = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(chatId ?? fromId), type: chatType },
      from: { id: Number(fromId), is_bot: false },
      text,
      ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}),
    },
  };
}

const handle = (u) => support.handleSupportUpdate(db, u, { send: fakeSend, typing: fakeTyping });
// The command bot's webhook passes `answerHelp: false`: it owns every /command, so
// this module must take only free text and admin replies.
const handleViaWebhook = (u) =>
  support.handleSupportUpdate(db, u, { send: fakeSend, typing: fakeTyping, answerHelp: false });
const stored = () => db.all(`SELECT * FROM supportMessages ORDER BY createdAt`);

// ── Inbound ──────────────────────────────────────────────────────────────────

test("a customer's message is stored and relayed to the admin chat", async () => {
  user("u1", { telegram: "555", displayName: "Khanh" });

  const result = await handle(update({ fromId: 555, text: "Gói Go của em hết hạn hôm nào?" }));

  assert.equal(result.handled, "customer");
  const [row] = stored();
  assert.equal(row.userId, "u1");
  assert.equal(row.direction, "in");
  assert.equal(row.telegramMessageId, 501);
  assert.equal(row.body, "Gói Go của em hết hạn hôm nào?");

  // Two messages left the bot: the relay to the admin, and the acknowledgement.
  const toAdmin = sent.find((m) => m.chatId === ADMIN_CHAT);
  assert.ok(toAdmin, "the admin chat received the relay");
  assert.match(toAdmin.text, /Khanh/);
  // "u1@gmail.com" → "u***@gmail.com": recognisable, not readable.
  assert.match(toAdmin.text, /u\*\*\*@gmail\.com/, "the email is masked, not printed");
  assert.match(toAdmin.text, /Gói Go của em hết hạn hôm nào\?/);
  assert.ok(sent.some((m) => m.chatId === "555" && /Đã gửi tới admin/.test(m.text)));
});

test("a relayed message is remembered so the admin's reply can be routed back", async () => {
  user("u1", { telegram: "555" });
  await handle(update({ fromId: 555, text: "Xin chào" }));

  const relay = sent.find((m) => m.chatId === ADMIN_CHAT);
  assert.ok(relay);
  // The relay is the FIRST message of the exchange; the acknowledgement follows, so
  // the counter has already moved past it.
  const relayId = nextMessageId - 1;
  const target = support.findSupportTargetByTelegramIdSync(db, relayId);
  assert.equal(target?.userId, "u1");
  assert.equal(target?.telegramUserId, "555");
});

test("the admin's reply on a relayed message reaches the customer and is stored", async () => {
  user("u1", { telegram: "555" });
  await handle(update({ fromId: 555, text: "Cần hỗ trợ" }));
  const relayId = nextMessageId - 1;

  sent = [];
  const reply = await handle(update({ fromId: Number(ADMIN_CHAT), chatId: ADMIN_CHAT, messageId: 777, text: "Gói của bạn hết hạn 10/12.", replyTo: relayId }));

  assert.equal(reply.handled, "admin_reply");
  const toCustomer = sent.find((m) => m.chatId === "555");
  assert.ok(toCustomer);
  assert.equal(toCustomer.text, "Gói của bạn hết hạn 10/12.");

  const out = stored().filter((row) => row.direction === "out");
  assert.equal(out.length, 1);
  assert.equal(out[0].body, "Gói của bạn hết hạn 10/12.");
  assert.ok(String(out[0].createdBy).startsWith("telegram:"));
});

test("a reply in the admin chat that answers nothing is ignored", async () => {
  user("u1", { telegram: "555" });
  const result = await handle(update({ fromId: Number(ADMIN_CHAT), chatId: ADMIN_CHAT, text: "lang thang", replyTo: 999999 }));
  assert.equal(result.handled, "ignored");
  assert.equal(sent.length, 0);
});

test("an unlinked chat is told how to link and nothing is forwarded", async () => {
  const result = await handle(update({ fromId: 777, text: "cho em hỏi" }));
  assert.equal(result.handled, "command");
  assert.equal(stored().length, 0, "nothing is stored for a chat with no account");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Chưa liên kết tài khoản/);
  assert.equal(sent[0].chatId, "777");
});

test("/help answers with instructions and does not relay", async () => {
  user("u1", { telegram: "555" });
  const result = await handle(update({ fromId: 555, text: "/help" }));
  assert.equal(result.handled, "command");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Hỗ trợ/);
  assert.ok(!sent.some((m) => m.chatId === ADMIN_CHAT), "no relay for a command");
});

test("/start help is a command, not a support message", async () => {
  user("u1", { telegram: "555" });
  const result = await handle(update({ fromId: 555, text: "/start help" }));
  assert.equal(result.handled, "command");
  assert.ok(!sent.some((m) => m.chatId === ADMIN_CHAT));
});

test("wired into the command bot, /help is left to it so one message gets one answer", async () => {
  user("u1", { telegram: "555" });
  const result = await handleViaWebhook(update({ fromId: 555, text: "/help" }));
  assert.equal(result.handled, "ignored");
  assert.equal(sent.length, 0, "this module sends nothing the command bot will also answer");
});

test("wired into the command bot, other commands are left to it too", async () => {
  user("u1", { telegram: "555" });
  for (const text of ["/me", "/plans", "/gift ABC123"]) {
    const result = await handleViaWebhook(update({ fromId: 555, text }));
    assert.equal(result.handled, "ignored", text);
  }
  assert.equal(sent.length, 0);
});

test("wired into the command bot, free text is still relayed", async () => {
  user("u1", { telegram: "555", displayName: "Khanh" });
  const result = await handleViaWebhook(update({ fromId: 555, text: "Gói của em hết hạn ngày nào?" }));
  assert.equal(result.handled, "customer");
  assert.ok(sent.some((m) => m.chatId === ADMIN_CHAT), "relayed to the admin chat");
  assert.equal(stored().length, 1);
});

test("wired into the command bot, an admin reply still reaches the customer", async () => {
  user("u1", { telegram: "555" });
  await handleViaWebhook(update({ fromId: 555, messageId: 700, text: "cần hỗ trợ" }));
  const relayId = nextMessageId - 1;

  sent = [];
  const result = await handleViaWebhook(
    update({ fromId: Number(ADMIN_CHAT), chatId: ADMIN_CHAT, messageId: 777, chatType: "group", text: "đã xử lý", replyTo: relayId })
  );
  assert.equal(result.handled, "admin_reply");
  assert.ok(sent.some((m) => m.chatId === "555" && /đã xử lý/.test(m.text)));
});

test("a re-delivered update is stored and relayed once", async () => {
  user("u1", { telegram: "555" });
  const u = update({ fromId: 555, messageId: 900, text: "Chỉ một lần thôi" });

  await handle(u);
  const afterFirst = sent.length;
  await handle(u); // Telegram re-sends an update whose offset was not confirmed

  assert.equal(stored().length, 1);
  assert.equal(sent.length, afterFirst, "no second relay, no second acknowledgement");
});

test("a suspended account is answered and nothing is relayed", async () => {
  user("u1", { telegram: "555", status: "suspended" });
  const result = await handle(update({ fromId: 555, text: "Cứu em" }));
  assert.equal(result.handled, "command");
  assert.equal(stored().length, 0);
  assert.ok(!sent.some((m) => m.chatId === ADMIN_CHAT));
  assert.match(sent[0].text, /tạm khoá/);
});

test("a group or channel message is ignored", async () => {
  user("u1", { telegram: "555" });
  const result = await handle(update({ fromId: 555, text: "hello", chatType: "group" }));
  assert.equal(result.handled, "ignored");
  assert.equal(sent.length, 0);
});

test("a non-text message is not forwarded, but the customer is told why", async () => {
  user("u1", { telegram: "555" });
  const u = update({ fromId: 555, text: undefined });
  u.message.photo = [{ file_id: "x" }];

  assert.equal((await handle(u)).handled, "ignored");
  assert.equal(stored().length, 0, "an attachment never enters the conversation");
  assert.ok(!sent.some((m) => m.chatId === ADMIN_CHAT), "nothing is relayed");
  // Silence would look like a broken bot; one line explains the supported form.
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /chỉ nhận tin nhắn dạng chữ/);
});

test("a message over the Telegram limit is refused, not truncated", async () => {
  user("u1", { telegram: "555" });
  const result = await handle(update({ fromId: 555, text: "a".repeat(MAX_MESSAGE_LENGTH + 1) }));
  assert.equal(result.handled, "command");
  assert.equal(stored().length, 0);
  assert.match(sent[0].text, /dài quá/);
});

// ── Dashboard reply ──────────────────────────────────────────────────────────

test("the dashboard can answer a customer through the same path", async () => {
  user("u1", { telegram: "555" });
  const result = await support.replyToCustomer({ userId: "u1", text: "Đã xử lý xong.", createdBy: "admin:me", send: fakeSend });

  assert.equal(result.ok, true);
  assert.equal(sent[0].chatId, "555");
  const [row] = stored();
  assert.equal(row.direction, "out");
  assert.equal(row.createdBy, "admin:me");
});

test("an answer Telegram refused is not stored as if it were delivered", async () => {
  user("u1", { telegram: "555" });
  const failing = async () => ({ ok: false, reason: "telegram_error" });
  const result = await support.replyToCustomer({ userId: "u1", text: "không tới được", send: failing });

  assert.equal(result.ok, false);
  assert.equal(stored().length, 0, "the customer never saw it, so it is not in the conversation");
});

test("a blocked answer marks the account so later sends stop", async () => {
  user("u1", { telegram: "555" });
  const blocked = async () => ({ ok: false, reason: "blocked", blocked: true });
  await support.replyToCustomer({ userId: "u1", text: "hi", send: blocked });

  const row = db.get(`SELECT telegramDmBlockedAt FROM users WHERE id = 'u1'`);
  assert.ok(row.telegramDmBlockedAt, "the account is marked as unreachable");
  assert.equal(stored().length, 0);
});

test("a dashboard reply to an unlinked account is refused", async () => {
  user("u2");
  const result = await support.replyToCustomer({ userId: "u2", text: "hi", send: fakeSend });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_linked");
  assert.equal(sent.length, 0);
});

test("HTML in a customer's message or an answer is escaped, never interpreted", async () => {
  user("u1", { telegram: "555" });
  await handle(update({ fromId: 555, text: "<b>bold</b> & <script>x</script>" }));
  const relay = sent.find((m) => m.chatId === ADMIN_CHAT);
  assert.match(relay.text, /&lt;b&gt;bold&lt;\/b&gt;/);

  sent = [];
  await support.replyToCustomer({ userId: "u1", text: "<i>hi</i>", send: fakeSend });
  assert.equal(sent[0].text, "&lt;i&gt;hi&lt;/i&gt;");
});

// ── Inbox queries ────────────────────────────────────────────────────────────

test("the inbox groups conversations and counts unread customer messages", async () => {
  user("u1", { telegram: "555" });
  user("u2", { telegram: "666" });

  await handle(update({ fromId: 555, messageId: 601, text: "tin 1" }));
  await handle(update({ fromId: 555, messageId: 602, text: "tin 2" }));
  await handle(update({ fromId: 666, messageId: 603, text: "tin 3" }));

  const threads = support.listSupportThreadsSync(db);
  assert.equal(threads.length, 2);
  const u1 = threads.find((t) => t.userId === "u1");
  assert.equal(u1.total, 2);
  assert.equal(u1.unread, 2);
  assert.equal(u1.lastBody, "tin 2");

  assert.equal(support.markSupportReadSync(db, "u1"), 2);
  assert.equal(support.listSupportThreadsSync(db).find((t) => t.userId === "u1").unread, 0);
  assert.equal(support.markSupportReadSync(db, "u1"), 0, "marking read twice changes nothing");
});

test("a conversation reads oldest first, so it renders top to bottom", async () => {
  user("u1", { telegram: "555" });
  db.transaction(() => {
    support.insertSupportMessageSync(db, { userId: "u1", direction: "in", body: "first", createdAt: "2026-01-01T00:00:00.000Z" });
    support.insertSupportMessageSync(db, { userId: "u1", direction: "out", body: "second", createdAt: "2026-01-01T00:01:00.000Z" });
    support.insertSupportMessageSync(db, { userId: "u1", direction: "in", body: "third", createdAt: "2026-01-01T00:02:00.000Z" });
  });

  assert.deepEqual(support.listSupportMessagesSync(db, "u1").map((m) => m.body), ["first", "second", "third"]);
});

// ── Polling ──────────────────────────────────────────────────────────────────

test("the offset confirms a batch before it is handled", async () => {
  user("u1", { telegram: "555" });
  const batches = [
    { ok: true, updates: [update({ updateId: 10, messageId: 700, fromId: 555, text: "a" })], offset: 11 },
    { ok: true, updates: [], offset: 11 },
  ];
  let call = 0;
  const getUpdates = async () => batches[Math.min(call++, batches.length - 1)];

  const first = await support.pollSupportUpdatesOnce({ getUpdates, send: fakeSend, typing: fakeTyping });
  assert.equal(first.ok, true);
  assert.equal(first.handled, 1);
  assert.equal(await getMeta("telegramSupportOffset", "0"), "11");

  const second = await support.pollSupportUpdatesOnce({ getUpdates, send: fakeSend, typing: fakeTyping });
  assert.equal(second.handled, 0);
  assert.equal(second.offset, 11, "a quiet poll keeps the offset");
});

test("polling without a bot token does nothing and says why", async () => {
  await updateSettings({ telegramBotToken: "" });
  const result = await support.pollSupportUpdatesOnce({
    getUpdates: async () => { throw new Error("must not be called"); },
    send: fakeSend,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_configured");
  await updateSettings({ telegramBotToken: "123:test" });
});

test("one malformed update does not stop the rest of the batch", async () => {
  user("u1", { telegram: "555" });
  const getUpdates = async () => ({
    ok: true,
    updates: [
      { update_id: 20 }, // no message at all
      update({ updateId: 21, messageId: 701, fromId: 555, text: "vẫn tới" }),
    ],
    offset: 22,
  });

  const result = await support.pollSupportUpdatesOnce({ getUpdates, send: fakeSend, typing: fakeTyping });
  assert.equal(result.ok, true);
  assert.equal(result.handled, 1);
  assert.equal(stored().length, 1);
});

// ── Transport ────────────────────────────────────────────────────────────────

test("sendMessage surfaces the message id and caps the body", async () => {
  let body = null;
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 42 } }) };
  };
  const result = await sendTelegramMessage("t", "1", "x".repeat(5000), { fetchImpl });
  assert.equal(result.messageId, 42);
  assert.equal(body.text.length, MAX_MESSAGE_LENGTH);
});

test("getUpdates asks only for plain messages and advances past the batch", async () => {
  let body = null;
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: [{ update_id: 4 }, { update_id: 9 }] }),
    };
  };
  const result = await getTelegramUpdates("t", { offset: 5, timeoutSec: 0, fetchImpl });
  assert.equal(result.ok, true);
  assert.deepEqual(body.allowed_updates, ["message"]);
  assert.equal(body.offset, 5);
  assert.equal(result.offset, 10, "next offset is one past the highest id");
});

test("getUpdates reports a conflict when another reader owns the stream", async () => {
  const fetchImpl = async () => ({ ok: false, status: 409, json: async () => ({ ok: false, description: "Conflict" }) });
  const result = await getTelegramUpdates("t", { timeoutSec: 0, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "conflict");
});

test("supportBotUrl follows the configured username", async () => {
  assert.equal(await support.supportBotUrl(), "https://t.me/derouter_bot?start=help");
  await updateSettings({ telegramBotUsername: "" });
  assert.equal(await support.supportBotUrl(), null);
  await updateSettings({ telegramBotUsername: "derouter_bot" });
});

// ── Regressions found by running the feature ────────────────────────────────

test("the admin chat may be a group, and its reply is routed", async () => {
  // The notification chat id is configured as `-100…`, i.e. a group. The
  // "private only" rule must not swallow the admin's answers.
  user("u1", { telegram: "555" });
  await handle(update({ fromId: 555, text: "cần hỗ trợ" }));
  const relayId = nextMessageId - 1;

  sent = [];
  const reply = await handle({
    update_id: 3,
    message: {
      message_id: 800,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(ADMIN_CHAT), type: "supergroup" },
      from: { id: 999, is_bot: false },
      text: "Đã xử lý nhé.",
      reply_to_message: { message_id: relayId },
    },
  });

  assert.equal(reply.handled, "admin_reply");
  assert.equal(sent[0].chatId, "555");
});

test("a group that is not the admin chat is still ignored", async () => {
  user("u1", { telegram: "555" });
  const result = await handle(update({ fromId: 555, chatId: "-100777", text: "chatter", chatType: "supergroup" }));
  assert.equal(result.handled, "ignored");
  assert.equal(sent.length, 0);
});

test("/help is not stored in the conversation", async () => {
  user("u1", { telegram: "555" });
  await handle(update({ fromId: 555, text: "/help" }));
  assert.equal(stored().length, 0, "a command is not a message the admin has to answer");
  assert.equal(support.listSupportThreadsSync(db).length, 0);
});

test("a customer is not told the message was delivered when the relay failed", async () => {
  user("u1", { telegram: "555" });
  // A transport that accepts the acknowledgement but refuses the relay is not
  // possible to express, so fail everything and check nothing claims success.
  const failing = async (token, chatId) => ({ ok: false, reason: "network_error" });

  const result = await support.handleSupportUpdate(db, update({ fromId: 555, text: "tới admin chưa?" }), {
    send: failing,
    typing: fakeTyping,
  });

  assert.equal(result.handled, "command");
  assert.equal(stored().length, 0, "nothing is stored for a message that never left");
});

test("a reply Telegram refused tells the admin, whatever the reason", async () => {
  user("u1", { telegram: "555" });
  await handle(update({ fromId: 555, text: "hỏi" }));
  const relayId = nextMessageId - 1;

  sent = [];
  // Only the answer to the CUSTOMER fails; the warning to the admin chat goes through,
  // which is the point of the behaviour under test.
  const failing = async (token, chatId) => {
    if (String(chatId) === String(ADMIN_CHAT)) {
      sent.push({ chatId: String(chatId), text: "warning" });
      return { ok: true, messageId: 1 };
    }
    return { ok: false, reason: "rate_limited" };
  };

  await support.handleSupportUpdate(db, {
    update_id: 4,
    message: {
      message_id: 801,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(ADMIN_CHAT), type: "supergroup" },
      from: { id: 999, is_bot: false },
      text: "trả lời",
      reply_to_message: { message_id: relayId },
    },
  }, { send: failing, typing: fakeTyping });

  assert.ok(sent.some((m) => m.chatId === ADMIN_CHAT), "the admin is told the answer did not arrive");
});

test("the same telegram message id on both sides is not a collision", () => {
  user("u1", { telegram: "555" });
  const inbound = support.insertSupportMessageSync(db, {
    userId: "u1", direction: "in", body: "của khách", telegramMessageId: 50,
  });
  const outbound = support.insertSupportMessageSync(db, {
    userId: "u1", direction: "out", body: "của admin", telegramMessageId: 50,
  });

  assert.equal(inbound.stored, true);
  assert.equal(outbound.stored, true, "the two chats number their messages independently");
  assert.equal(stored().length, 2);
});

test("deleting an account removes its conversation and relay mapping", () => {
  user("u1", { telegram: "555" });
  support.insertSupportMessageSync(db, { userId: "u1", direction: "in", body: "xin chào" });
  db.run(`INSERT INTO kv(scope, key, value) VALUES('telegramSupportRelay', '9001', 'u1')`);

  return import("../src/lib/db/repos/userRepo.js").then(async ({ deleteUser }) => {
    await deleteUser("u1");
    assert.equal(stored().length, 0, "customer-written text does not outlive the account");
    assert.equal(
      db.get(`SELECT COUNT(*) AS n FROM kv WHERE scope = 'telegramSupportRelay'`).n,
      0,
      "a relay mapping to a deleted account can only answer into nothing"
    );
  });
});

test("one customer cannot flood the bot into a token-wide rate limit", async () => {
  user("u1", { telegram: "555" });
  const outcomes = [];
  for (let i = 0; i < support.INBOUND_LIMIT.limit + 3; i += 1) {
    outcomes.push(await handle(update({ fromId: 555, messageId: 2000 + i, text: `tin ${i}` })));
  }

  const delivered = outcomes.filter((o) => o.handled === "customer").length;
  assert.equal(delivered, support.INBOUND_LIMIT.limit, "the budget is exactly the limit");
  assert.ok(
    outcomes.some((o) => o.handled === "command"),
    "the rest are answered, not dropped silently"
  );
  // Nothing beyond the budget reaches the admin chat.
  assert.equal(sent.filter((m) => m.chatId === ADMIN_CHAT).length, support.INBOUND_LIMIT.limit);
});

test("a wrong bot token is a configuration error, not a transient failure", async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ ok: false, description: "Unauthorized" }) });
  const result = await getTelegramUpdates("t", { timeoutSec: 0, fetchImpl });
  assert.equal(result.ok, false);
  // The loop backs off a minute on this, instead of retrying every 5 seconds.
  assert.equal(result.reason, "invalid_token");
});
