// Buying a plan from the Telegram bot (change bot-orders).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-bot-orders-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const billing = await import("../src/lib/db/repos/billingRepo.js");
const { handleUpdate } = await import("../src/lib/telegram/bot/handler.js");

const USD = (n) => Math.round(n * 1e9);
let db;
let planId;

before(async () => { db = await getAdapter(); });
after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(async () => {
  for (const t of ["orders", "plans", "users", "paymentProviders", "activityLog", "userPlans", "creditLedger"]) db.run(`DELETE FROM ${t}`);
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO users(id, email, passwordHash, status, overdraftNanoUsd, telegramUserId, createdAt, updatedAt)
     VALUES('cust', 'cust@test.local', 'x', 'active', 0, '501', ?, ?)`,
    [now, now]
  );
  for (const [id, kind] of [["v1", "sepay"], ["b1", "binance"]]) {
    db.run(
      `INSERT INTO paymentProviders(id, kind, name, isActive, sortOrder, config, secrets, pollIntervalSeconds, createdAt, updatedAt)
       VALUES(?, ?, ?, 1, 0, ?, '{}', 30, ?, ?)`,
      [id, kind, id, JSON.stringify({ accountNumber: "1017588888", bankBin: "970436", bankName: "VCB", accountName: "DELIFY", payUid: "123456" }), now, now]
    );
  }
  const plan = await billing.createPlan({ code: "go", name: "Go", priceNanoUsd: USD(10), priceVnd: 250000, creditNanoUsd: USD(250), durationDays: 30 });
  planId = plan.id;
});

function fakeApi({ photoOk = true } = {}) {
  const calls = [];
  return {
    calls,
    send: async (chatId, text, markup = null) => { calls.push({ type: "send", text, markup }); return { ok: true }; },
    edit: async (chatId, id, text, markup = null) => { calls.push({ type: "edit", text, markup }); return { ok: true }; },
    photo: async (chatId, url, caption = "", markup = null) => { calls.push({ type: "photo", url, caption, markup }); return { ok: photoOk }; },
    answer: async () => ({ ok: true }),
  };
}
let uid = 1;
const press = (data) => ({ update_id: uid++, callback_query: { id: `c${uid}`, data, from: { id: 501, is_bot: false }, message: { message_id: 9, chat: { id: 501, type: "private" } } } });
const msg = (text) => ({ update_id: uid++, message: { message_id: 1, text, chat: { id: 501, type: "private" }, from: { id: 501, is_bot: false } } });

async function run(update, extra = {}) {
  const api = fakeApi(extra);
  const settings = extra.settings || {};
  const notified = [];
  await handleUpdate(update, {
    db, settings, api, baseUrl: "https://ai.example.vn", reserve: () => true,
    onOrderCreated: async (payload) => { notified.push(payload); },
  });
  return { calls: api.calls, notified };
}
const buttons = (call) => (call?.markup?.inline_keyboard || []).flat();

test("/plans offers a buy button; the plan shows the methods it sells by", async () => {
  const { calls } = await run(msg("/plans"));
  assert.ok(buttons(calls.at(-1)).some((b) => b.callback_data === `bp:${planId}`));
  const detail = (await run(press(`bp:${planId}`))).calls.at(-1);
  const data = buttons(detail).map((b) => b.callback_data);
  assert.ok(data.includes(`bm:${planId}:v`));
  assert.ok(data.includes(`bm:${planId}:b`));
  assert.ok(data.every((d) => !d || Buffer.byteLength(d) <= 64));
});

test("a VietQR order is created with its QR and transfer details, and the admin is told", async () => {
  const { calls, notified } = await run(press(`bm:${planId}:v`));
  const order = db.get(`SELECT * FROM orders WHERE userId = 'cust'`);
  assert.equal(order.status, "pending");
  assert.equal(order.payCurrency, "VND");
  assert.equal(order.payAmount, 250000);
  const photo = calls.find((c) => c.type === "photo");
  assert.match(photo.url, /^https:\/\/img\.vietqr\.io\/image\/970436-1017588888/);
  assert.match(photo.caption, new RegExp(order.paymentCode));
  assert.match(photo.caption, /1017588888/);
  assert.equal(notified.length, 1);
  assert.equal(notified[0].orderId, order.id);
  assert.match(db.get(`SELECT details FROM activityLog WHERE action = 'order_create'`).details, /telegram_bot/);
});

test("when the QR image fails the details still arrive as text", async () => {
  const { calls } = await run(press(`bm:${planId}:v`), { photoOk: false });
  const order = db.get(`SELECT paymentCode FROM orders WHERE userId = 'cust'`);
  assert.ok(calls.some((c) => c.type === "send" && c.text.includes(order.paymentCode)));
});

test("check, pay again and cancel an own pending order; a paid order reports done", async () => {
  await run(press(`bm:${planId}:b`));
  const order = db.get(`SELECT * FROM orders WHERE userId = 'cust'`);
  assert.equal(order.payCurrency, "USDT");
  assert.match((await run(press(`us:${order.id}`))).calls.at(-1).text, /Chưa nhận được thanh toán/);
  const list = (await run(msg("/myorders"))).calls.at(-1);
  assert.ok(buttons(list).some((b) => b.callback_data === `uc:${order.id}`));

  await billing.approveOrder(order.id, "admin");
  assert.match((await run(press(`us:${order.id}`))).calls.at(-1).text, /đã thanh toán/);
  assert.match((await run(press(`uc:${order.id}`))).calls.at(-1).text, /Không hủy được/);
});

test("cancel works on a pending order and never touches another customer's order", async () => {
  await run(press(`bm:${planId}:v`));
  const order = db.get(`SELECT * FROM orders WHERE userId = 'cust'`);
  db.run(`UPDATE orders SET userId = 'someone-else' WHERE id = ?`, [order.id]);
  assert.match((await run(press(`uc:${order.id}`))).calls.at(-1).text, /Không tìm thấy đơn/);
  db.run(`UPDATE orders SET userId = 'cust' WHERE id = ?`, [order.id]);
  assert.match((await run(press(`uc:${order.id}`))).calls.at(-1).text, /Đã hủy đơn/);
  assert.equal(db.get(`SELECT status FROM orders WHERE id = ?`, [order.id]).status, "cancelled");
});

test("a method the plan does not offer is refused", async () => {
  const { calls } = await run(press(`bm:${planId}:m`), { settings: { allowManualOrders: false } });
  assert.match(calls.at(-1).text, /không còn mở/);
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM orders`).n, 0);
});

test("a second tap reuses the unpaid order; a broken notifier never hides the payment details", async () => {
  const api = fakeApi();
  const deps = { db, settings: {}, api, baseUrl: "https://ai.example.vn", reserve: () => true, onOrderCreated: () => { throw new Error("chat down"); } };
  await handleUpdate(press(`bm:${planId}:v`), deps);
  await handleUpdate(press(`bm:${planId}:v`), deps);
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM orders`).n, 1);
  const order = db.get(`SELECT paymentCode FROM orders`);
  assert.equal(api.calls.filter((c) => c.type === "photo" && c.caption.includes(order.paymentCode)).length, 2);
});

test("another customer's order cannot be checked or paid; a manual order waits for the admin", async () => {
  await run(press(`bm:${planId}:m`));
  const order = db.get(`SELECT * FROM orders WHERE userId = 'cust'`);
  assert.equal(order.method, "manual");
  assert.match((await run(press(`up:${order.id}`))).calls.at(-1).text, /chờ admin duyệt/);
  db.run(`UPDATE orders SET userId = 'other' WHERE id = ?`, [order.id]);
  assert.match((await run(press(`us:${order.id}`))).calls.at(-1).text, /Không tìm thấy đơn/);
  assert.match((await run(press(`up:${order.id}`))).calls.at(-1).text, /Không tìm thấy đơn/);
});

test("a custom-amount plan: quick 1× / 2× amounts, a typed amount, and the order carries it", async () => {
  db.run(`UPDATE plans SET allowCustomAmount = 1, customMinVnd = 50000, customMaxVnd = 10000000 WHERE id = ?`, [planId]);
  const choice = (await run(press(`bp:${planId}`))).calls.at(-1);
  const data = buttons(choice).map((b) => b.callback_data);
  assert.ok(data.includes(`ba:${planId}:250000`), "1 gói = the plan's price");
  assert.ok(data.includes(`ba:${planId}:500000`), "2 gói = twice the price");
  assert.ok(data.includes(`bn:${planId}`));

  const methods = (await run(press(`ba:${planId}:500000`))).calls.at(-1);
  assert.match(methods.text, /500\.000đ/);
  assert.match(methods.text, /\$500\.00/, "credit at the plan's rate: 250.000đ buys $250");
  assert.ok(buttons(methods).some((b) => b.callback_data === `bm:${planId}:v:500000`));
  assert.ok(buttons(methods).every((b) => !b.callback_data || Buffer.byteLength(b.callback_data) <= 64));

  const { calls } = await run(press(`bm:${planId}:v:500000`));
  const order = db.get(`SELECT * FROM orders WHERE userId = 'cust'`);
  assert.equal(order.payAmount, 500000);
  assert.equal(order.creditNanoUsd, USD(500));
  assert.ok(calls.some((c) => c.type === "photo" && /amount=500000/.test(c.url)), "the QR carries the amount");

  // Same amount again: the unpaid order is reused; another amount is a new order.
  await run(press(`bm:${planId}:v:500000`));
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM orders`).n, 1);
  await run(press(`bm:${planId}:v:250000`));
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM orders`).n, 2);
});

test("typing an amount answers the bot's prompt; bad amounts are explained", async () => {
  db.run(`UPDATE plans SET allowCustomAmount = 1, customMinVnd = 50000, customMaxVnd = 10000000 WHERE id = ?`, [planId]);
  const ask = (await run(press(`bn:${planId}`))).calls.at(-1);
  assert.equal(ask.markup.force_reply, true);
  const reply = (text) => ({
    update_id: uid++,
    message: {
      message_id: 2, text, chat: { id: 501, type: "private" }, from: { id: 501, is_bot: false },
      reply_to_message: { message_id: 1, text: ask.text.replace(/<[^>]+>/g, ""), from: { id: 1, is_bot: true } },
    },
  });
  const ok = (await run(reply("700k"))).calls.at(-1);
  assert.match(ok.text, /700\.000đ/);
  assert.ok(buttons(ok).some((b) => b.callback_data === `bm:${planId}:v:700000`));
  assert.match((await run(reply("10k"))).calls.at(-1).text, /tối thiểu/);
  assert.match((await run(reply("abc"))).calls.at(-1).text, /Không đọc được số tiền/);
  // A fixed amount sent without going through a choice is refused back to the choice.
  assert.match((await run(press(`bm:${planId}:v`))).calls.at(-1).text, /nạp số tiền tùy ý/);
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM orders`).n, 0);
});

test("the web cancel never turns a paid order into a cancelled one", async () => {
  await run(press(`bm:${planId}:v`));
  const order = db.get(`SELECT * FROM orders WHERE userId = 'cust'`);
  await billing.approveOrder(order.id, "admin");
  assert.deepEqual(await billing.cancelOrder(order.id, "cust"), { ok: false, reason: "not_pending" });

  // Paid by another process between the read and the write: the read still says
  // pending, the guarded write must change nothing.
  const realGet = db.get.bind(db);
  db.get = (sql, params) => {
    const row = realGet(sql, params);
    return /FROM orders WHERE id = \?/.test(sql) && row ? { ...row, status: "pending" } : row;
  };
  try {
    assert.deepEqual(await billing.cancelOrder(order.id, "cust"), { ok: false, reason: "not_pending" });
  } finally {
    db.get = realGet;
  }
  assert.equal(db.get(`SELECT status FROM orders WHERE id = ?`, [order.id]).status, "paid");

  db.run(`UPDATE orders SET status = 'pending' WHERE id = ?`, [order.id]);
  assert.equal((await billing.cancelOrder(order.id, "cust")).ok, true);
});

test("custom amounts: blocked plans, replies to other messages, suspended accounts, odd amounts", async () => {
  const { parseVndAmount } = await import("../src/lib/telegram/bot/orders.js");
  assert.equal(parseVndAmount("1.2345k"), null, "no fractional đồng");
  assert.equal(parseVndAmount("1.5tr"), 1500000);
  assert.equal(parseVndAmount("-500k"), null);

  db.run(`UPDATE plans SET allowCustomAmount = 1, customMinVnd = 50000, customMaxVnd = 10000000 WHERE id = ?`, [planId]);
  // A reply to a message that is not the bot's prompt is not an amount.
  const notPrompt = {
    update_id: uid++,
    message: {
      message_id: 3, text: "500k", chat: { id: 501, type: "private" }, from: { id: 501, is_bot: false },
      reply_to_message: { message_id: 1, text: `Mã gói: ${planId}`, from: { id: 501, is_bot: false } },
    },
  };
  assert.match((await run(notPrompt)).calls.at(-1).text, /Gõ \/help/);

  db.run(`UPDATE plans SET isActive = 0 WHERE id = ?`, [planId]);
  assert.match((await run(press(`ba:${planId}:500000`))).calls.at(-1).text, /Chưa mua được/);
  assert.match((await run(press(`bn:${planId}`))).calls.at(-1).text, /Chưa mua được/);
  assert.match((await run(press(`bm:${planId}:v`))).calls.at(-1).text, /Chưa mua được/);
  db.run(`UPDATE plans SET isActive = 1 WHERE id = ?`, [planId]);

  db.run(`UPDATE users SET status = 'suspended' WHERE id = 'cust'`);
  const prompt = {
    update_id: uid++,
    message: {
      message_id: 4, text: "500k", chat: { id: 501, type: "private" }, from: { id: 501, is_bot: false },
      reply_to_message: { message_id: 1, text: `Nhập số tiền cho gói Go\nMã gói: ${planId}`, from: { id: 1, is_bot: true } },
    },
  };
  assert.match((await run(prompt)).calls.at(-1).text, /bị khoá/);
  db.run(`UPDATE users SET status = 'active' WHERE id = 'cust'`);
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM orders`).n, 0);
});
