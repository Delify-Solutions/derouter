// Telegram command bot (change telegram-bot-commands): customer and admin
// commands through handleUpdate with a recording fake Bot API.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-tgbot-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const gifts = await import("../src/lib/db/repos/giftRepo.js");
const billing = await import("../src/lib/db/repos/billingRepo.js");
const { handleUpdate, parseCommand } = await import("../src/lib/telegram/bot/handler.js");
const config = await import("../src/lib/telegram/bot/config.js");
const { adminIdsOf } = await import("../src/lib/telegram/bot/admin.js");

const USD = (n) => Math.round(n * 1e9);
const ADMIN_TG = 9001;
let db;

before(async () => { db = await getAdapter(); });
after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(() => {
  for (const table of ["giftRedemptions", "giftCodes", "creditLedger", "userPlans", "orders", "plans", "users", "activityLog", "userAuditLog", "apiKeys"]) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* ignore */ }
  }
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO users(id, email, passwordHash, status, overdraftNanoUsd, telegramUserId, telegramUsername, createdAt, updatedAt)
     VALUES('cust', 'cust@test.local', 'x', 'active', 0, '501', 'cust501', ?, ?)`,
    [now, now]
  );
  db.run(
    `INSERT INTO users(id, email, passwordHash, status, overdraftNanoUsd, createdAt, updatedAt)
     VALUES('other', 'other@test.local', 'x', 'active', 0, ?, ?)`,
    [now, now]
  );
});

function fakeApi() {
  const calls = [];
  return {
    calls,
    send: async (chatId, text, markup = null) => { calls.push({ type: "send", chatId, text, markup }); return { ok: true }; },
    edit: async (chatId, messageId, text, markup = null) => { calls.push({ type: "edit", chatId, messageId, text, markup }); return { ok: true }; },
    answer: async (id, text = "") => { calls.push({ type: "answer", id, text }); return { ok: true }; },
  };
}

const SETTINGS = { telegramAdminIds: [String(ADMIN_TG)] };
let updateId = 1;
const msg = (fromId, text, chatType = "private") => ({
  update_id: updateId++,
  message: { message_id: 1, text, chat: { id: fromId, type: chatType }, from: { id: fromId, is_bot: false, username: `u${fromId}` } },
});
const press = (fromId, data) => ({
  update_id: updateId++,
  callback_query: { id: `cb${updateId}`, data, from: { id: fromId, is_bot: false }, message: { message_id: 77, chat: { id: fromId, type: "private" } } },
});

async function run(update, extra = {}) {
  const api = fakeApi();
  await handleUpdate(update, { db, settings: SETTINGS, api, siteName: "derouter", baseUrl: "https://ai.example.vn", reserve: () => true, ...extra });
  return api.calls;
}
const lastText = (calls) => calls.filter((c) => c.type !== "answer").at(-1)?.text || "";
const buttons = (calls) => (calls.filter((c) => c.type !== "answer").at(-1)?.markup?.inline_keyboard || []).flat();

test("commands parse with a bot suffix and an argument", () => {
  assert.deepEqual(parseCommand("/gift@MyBot  abc-123 "), { command: "gift", arg: "abc-123" });
  assert.deepEqual(parseCommand("/ME"), { command: "me", arg: "" });
  assert.equal(parseCommand("hello"), null);
});

test("an unlinked Telegram user is told to link; /id answers anyone", async () => {
  const calls = await run(msg(777, "/me"));
  assert.match(lastText(calls), /chưa liên kết/);
  assert.ok(buttons(calls).some((b) => b.url === "https://ai.example.vn/account"));
  assert.match(lastText(await run(msg(777, "/id"))), /777/);
});

test("group chats are ignored", async () => {
  const calls = await run(msg(501, "/me", "group"));
  assert.equal(calls.length, 0);
});

test("/gift redeems for the linked account and /me shows the credit", async () => {
  await gifts.createGiftCode({ code: "BOTGIFT", creditNanoUsd: USD(3), durationDays: 7, maxRedemptions: 10 });
  const first = await run(msg(501, "/gift botgift"));
  assert.match(lastText(first), /Đã nhận mã/);
  assert.match(lastText(await run(msg(501, "/gift BOTGIFT"))), /đã dùng mã này/);
  assert.match(lastText(await run(msg(501, "/me"))), /\$3\.00/);
  const logged = db.get(`SELECT details FROM activityLog WHERE userId = 'cust' AND action = 'gift_redeem'`);
  assert.match(logged.details, /telegram_bot/);
});

test("a channel code checks membership of the writer and offers a retry", async () => {
  const settings = { ...SETTINGS, telegramBotToken: "1:t", telegramChannelUrl: "https://t.me/delify_ai" };
  await gifts.createGiftCode({ code: "JOINBOT", creditNanoUsd: USD(10), durationDays: 30, maxRedemptions: 10, channelJoinOnly: true, listed: true });
  const seen = [];
  const notMember = async (_t, chat, tg) => { seen.push([chat, tg]); return { ok: true, member: false }; };
  const refused = await run(msg(501, "/gift JOINBOT"), { settings, checkMember: notMember });
  assert.match(lastText(refused), /chưa ở trong kênh/);
  assert.ok(buttons(refused).some((b) => b.callback_data === "g:JOINBOT"));
  assert.deepEqual(seen[0], ["@delify_ai", "501"]);

  const member = async () => ({ ok: true, member: true });
  const ok = await run(press(501, "g:JOINBOT"), { settings, checkMember: member });
  assert.equal(ok.find((c) => c.type === "send")?.text.includes("Đã nhận mã"), true, "a redeem button adds a new message");
});

test("/gifts lists listed codes with take buttons", async () => {
  await gifts.createGiftCode({ code: "LISTED5", creditNanoUsd: USD(5), durationDays: 7, maxRedemptions: 10, listed: true });
  const calls = await run(msg(501, "/gifts"));
  assert.match(lastText(calls), /LISTED5/);
  assert.ok(buttons(calls).some((b) => b.callback_data === "g:LISTED5"));
});

test("settings toggle a notification group and unlink after confirmation", async () => {
  const toggled = await run(press(501, "n:billing"));
  assert.equal(toggled.find((c) => c.type === "edit").messageId, 77);
  assert.match(lastText(toggled), /Thanh toán và gói: <b>TẮT<\/b>/);
  const prefs = JSON.parse(db.get(`SELECT telegramNotifyPrefs FROM users WHERE id = 'cust'`).telegramNotifyPrefs);
  assert.equal(prefs.billing, false);

  await run(press(501, "u:yes"));
  assert.equal(db.get(`SELECT telegramUserId FROM users WHERE id = 'cust'`).telegramUserId, null);
});

test("admin commands are invisible to customers", async () => {
  assert.match(lastText(await run(msg(501, "/stats"))), /Không có lệnh này/);
  assert.match(lastText(await run(press(501, "oy:anything"))), /Không có quyền/);
});

test("an admin approves a pending order in two taps and the customer gets the plan", async () => {
  await billing.createPlan({ code: "go", name: "Go", priceNanoUsd: USD(1), priceVnd: 10000, creditNanoUsd: USD(10), durationDays: 30 });
  const plan = db.get(`SELECT id FROM plans WHERE code = 'go'`);
  const order = await billing.createOrder({ userId: "cust", planId: plan.id, method: "manual" });

  const list = await run(msg(ADMIN_TG, "/orders"));
  assert.match(lastText(list), /Đơn chờ duyệt/);
  assert.ok(buttons(list).some((b) => b.callback_data === `oa:${order.id}`));

  const confirm = await run(press(ADMIN_TG, `oa:${order.id}`));
  assert.match(lastText(confirm), /DUYỆT đơn này/);
  assert.equal(db.get(`SELECT status FROM orders WHERE id = ?`, [order.id]).status, "pending", "one tap does nothing");

  const done = await run(press(ADMIN_TG, `oy:${order.id}`));
  assert.match(lastText(done), /Đã duyệt đơn/);
  const row = db.get(`SELECT status, approvedBy FROM orders WHERE id = ?`, [order.id]);
  assert.equal(row.status, "paid");
  assert.match(row.approvedBy, /^telegram:9001/);
  assert.ok(db.get(`SELECT id FROM userPlans WHERE userId = 'cust'`));
  assert.match(lastText(await run(msg(ADMIN_TG, "/stats"))), /Đơn đã thanh toán: <b>1<\/b>/);
});

test("an admin cancels a pending order and it is audited", async () => {
  await billing.createPlan({ code: "go2", name: "Go2", priceNanoUsd: USD(1), priceVnd: 10000, creditNanoUsd: USD(10), durationDays: 30 });
  const plan = db.get(`SELECT id FROM plans WHERE code = 'go2'`);
  const order = await billing.createOrder({ userId: "cust", planId: plan.id, method: "manual" });
  await run(press(ADMIN_TG, `ox:${order.id}`));
  assert.equal(db.get(`SELECT status FROM orders WHERE id = ?`, [order.id]).status, "cancelled");
  assert.ok(db.get(`SELECT id FROM userAuditLog WHERE userId = 'cust' AND action = 'order_cancelled'`));
});

test("/user finds an account by email, id or @telegram", async () => {
  assert.match(lastText(await run(msg(ADMIN_TG, "/user CUST@test.local"))), /cust@test\.local/);
  assert.match(lastText(await run(msg(ADMIN_TG, "/user @cust501"))), /cust@test\.local/);
  assert.match(lastText(await run(msg(ADMIN_TG, "/user nobody@x.y"))), /Không tìm thấy/);
});

test("config helpers: secret compare, admin ids, base URL", () => {
  const secret = config.newWebhookSecret();
  assert.equal(config.webhookSecretMatches(secret, secret), true);
  assert.equal(config.webhookSecretMatches(secret, `${secret}x`), false);
  assert.equal(config.webhookSecretMatches("", ""), false, "no secret set: nothing matches");
  assert.equal(config.webhookSecretMatches(secret, null), false);
  assert.deepEqual(config.normalizeAdminIds("1, 2 2"), { value: ["1", "2"] });
  assert.ok(config.normalizeAdminIds("abc").error);
  assert.deepEqual(adminIdsOf({ telegramAdminIds: "5,x,6" }), ["5", "6"]);
  assert.equal(config.normalizeBaseUrl("https://ai.delify.vn/path"), "https://ai.delify.vn");
  assert.equal(config.normalizeBaseUrl("http://ai.delify.vn"), "");
  assert.equal(config.botBaseUrlOf({ publicBaseUrl: "https://a.vn/", telegramBotBaseUrl: "https://b.vn" }), "https://a.vn");
});

test("/usage names the model the customer called, never the upstream one", async () => {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO usageHistory(id, timestamp, model, meta, costNanoUsd) VALUES(901, ?, 'upstream-secret-model', ?, 1000)`,
    [now, JSON.stringify({ requestedModel: "gpt-5" })]
  );
  db.run(
    `INSERT INTO creditLedger(userId, usageId, deltaNanoUsd, kind, createdAt) VALUES('cust', 901, -1000000, 'charge', ?)`,
    [now]
  );
  const text = lastText(await run(msg(501, "/usage")));
  assert.match(text, /gpt-5/);
  assert.doesNotMatch(text, /upstream-secret-model/);
  db.run(`DELETE FROM usageHistory WHERE id = 901`);
});

test("long replies are cut at a line break, never inside a tag", async () => {
  const { fitText } = await import("../src/lib/telegram/botApi.js");
  const line = "<b>x&amp;y</b>\n";
  const long = line.repeat(400);
  const out = fitText(long);
  assert.ok(out.length <= 4096);
  assert.ok(out.endsWith("\n…"));
  assert.equal((out.match(/<b>/g) || []).length, (out.match(/<\/b>/g) || []).length);
});

test("a stale approve on a cancelled order answers in Vietnamese; menu buttons respect the admin gate", async () => {
  await billing.createPlan({ code: "go3", name: "Go3", priceNanoUsd: USD(1), priceVnd: 10000, creditNanoUsd: USD(10), durationDays: 30 });
  const plan = db.get(`SELECT id FROM plans WHERE code = 'go3'`);
  const order = await billing.createOrder({ userId: "cust", planId: plan.id, method: "manual" });
  await run(press(ADMIN_TG, `ox:${order.id}`));
  assert.match(lastText(await run(press(ADMIN_TG, `oy:${order.id}`))), /trạng thái "cancelled"/);
  assert.match(lastText(await run(press(501, "m:stats"))), /Không có lệnh này/);
});

test("a suspended account gets no data", async () => {
  db.run(`UPDATE users SET status = 'suspended' WHERE id = 'cust'`);
  assert.match(lastText(await run(msg(501, "/me"))), /bị khoá/);
});

test("writing to the bot resumes notifications paused by a blocked chat", async () => {
  db.run(`UPDATE users SET telegramDmBlockedAt = ? WHERE id = 'cust'`, [new Date().toISOString()]);
  await run(msg(501, "/start"));
  assert.equal(db.get(`SELECT telegramDmBlockedAt AS b FROM users WHERE id = 'cust'`).b, null);
});
