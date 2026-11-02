// Customer notifications over the linked Telegram (spec telegram-notify).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-tg-notify-"));
// DATA_DIR must be set before the DB driver is imported.
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const { updateSettings } = await import("../src/lib/db/repos/settingsRepo.js");
const { sendTelegramMessage } = await import("../src/lib/notify/telegramApi.js");
const notify = await import("../src/lib/notify/customerTelegram.js");
const reminders = await import("../src/lib/notify/planReminders.js");
const broadcast = await import("../src/lib/notify/broadcast.js");
const { issueLinkTokenSync, consumeLinkTokenSync } = await import("../src/lib/db/repos/telegramLinkRepo.js");

let db;
let sent = [];
let reply = () => ({ ok: true });

before(async () => {
  db = await getAdapter();
  await updateSettings({ telegramBotToken: "123:test", siteName: "derouter" });
  notify.setTelegramTransportForTests(async (token, chatId, text) => {
    sent.push({ chatId, text });
    return reply(chatId);
  });
});
after(() => {
  notify.setTelegramTransportForTests(null);
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(() => {
  for (const table of ["users", "userPlans", "plans", "telegramNotices", "telegramBroadcasts", "activityLog", "telegramLinkTokens"]) {
    db.run(`DELETE FROM ${table}`);
  }
  sent = [];
  reply = () => ({ ok: true });
});

function user(id, { telegram = null, prefs = null, blocked = null, status = "active" } = {}) {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO users(id, email, passwordHash, status, overdraftNanoUsd, createdAt, updatedAt,
                       telegramUserId, telegramNotifyPrefs, telegramDmBlockedAt)
     VALUES(?, ?, 'x', ?, 0, ?, ?, ?, ?, ?)`,
    [id, `${id}@test.local`, status, now, now, telegram, prefs ? JSON.stringify(prefs) : null, blocked]
  );
}

const DAY = 24 * 60 * 60 * 1000;
function plan(id, userId, { startsIn = -DAY, endsIn, total = 10e9, remaining = 10e9, unlimited = 0, status = "active", orderId = null } = {}) {
  const now = Date.now();
  db.run(
    `INSERT INTO userPlans(id, userId, planId, orderId, source, creditTotalNanoUsd, creditRemainingNanoUsd, unlimitedCredit,
                           startsAt, expiresAt, status, createdAt)
     VALUES(?, ?, 'p1', ?, 'purchase', ?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, orderId, total, remaining, unlimited, new Date(now + startsIn).toISOString(),
      new Date(now + endsIn).toISOString(), status, new Date().toISOString()]
  );
}

function seedPlanRow() {
  db.run(`INSERT INTO plans(id, code, name, priceNanoUsd, creditNanoUsd, durationDays) VALUES('p1', 'go', 'Go', 1, 1, 30)`);
}

// ── Transport ────────────────────────────────────────────────────────────────

test("Telegram answers map to delivered, blocked and flood-limited", async () => {
  const answer = (status, body) => async () => ({ ok: status === 200, status, json: async () => body });
  assert.deepEqual(await sendTelegramMessage("t", "1", "hi", { fetchImpl: answer(200, { ok: true }) }), { ok: true });
  assert.equal((await sendTelegramMessage("t", "1", "hi", { fetchImpl: answer(403, { description: "Forbidden: bot was blocked by the user" }) })).blocked, true);
  assert.equal((await sendTelegramMessage("t", "1", "hi", { fetchImpl: answer(400, { description: "Bad Request: chat not found" }) })).blocked, true);
  const flood = await sendTelegramMessage("t", "1", "hi", { fetchImpl: answer(429, { parameters: { retry_after: 7 } }) });
  assert.equal(flood.reason, "rate_limited");
  assert.equal(flood.retryAfterSec, 7);
  assert.equal((await sendTelegramMessage("", "1", "hi")).reason, "not_configured");
});

// ── Preferences and delivery ─────────────────────────────────────────────────

test("prefs default to on and only booleans for known groups change them", () => {
  assert.deepEqual(notify.parseNotifyPrefs(null), { billing: true, expiry: true, announcements: true });
  assert.deepEqual(notify.parseNotifyPrefs("{bad"), { billing: true, expiry: true, announcements: true });
  assert.deepEqual(
    notify.mergeNotifyPrefs('{"billing":false}', { expiry: false, announcements: "no", security: false }),
    { billing: false, expiry: false, announcements: true }
  );
});

test("a group the customer turned off is skipped, security is always sent", async () => {
  user("u1", { telegram: "111", prefs: { billing: false } });
  assert.equal((await notify.notifyCustomer("u1", "billing", notify.messages.test())).reason, "opted_out");
  assert.equal((await notify.notifyCustomer("u1", "security", notify.messages.passwordChanged())).ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, "111");
  assert.match(sent[0].text, /Mật khẩu đã thay đổi/);
  user("u2");
  assert.equal((await notify.notifyCustomer("u2", "security", notify.messages.test())).reason, "not_linked");
});

test("a refused delivery marks the account and stops sending until a forced message gets through", async () => {
  user("u1", { telegram: "111" });
  reply = () => ({ ok: false, blocked: true, reason: "blocked" });
  await notify.notifyCustomer("u1", "billing", notify.messages.test());
  assert.ok(db.get(`SELECT telegramDmBlockedAt FROM users WHERE id = 'u1'`).telegramDmBlockedAt);

  sent = [];
  reply = () => ({ ok: true });
  assert.equal((await notify.notifyCustomer("u1", "billing", notify.messages.test())).reason, "blocked");
  assert.equal(sent.length, 0);

  assert.equal((await notify.notifyCustomer("u1", "security", notify.messages.test(), { force: true })).ok, true);
  assert.equal(db.get(`SELECT telegramDmBlockedAt FROM users WHERE id = 'u1'`).telegramDmBlockedAt, null);
});

test("a fresh link clears the refused-delivery marker", () => {
  user("u1", { blocked: new Date().toISOString() });
  const { token } = issueLinkTokenSync(db, "u1");
  assert.equal(consumeLinkTokenSync(db, token, { id: "555", username: "x" }).ok, true);
  const row = db.get(`SELECT telegramUserId, telegramDmBlockedAt FROM users WHERE id = 'u1'`);
  assert.equal(row.telegramUserId, "555");
  assert.equal(row.telegramDmBlockedAt, null);
});

test("message text escapes customer-controlled values", () => {
  const text = notify.messages.apiKeyCreated({ name: "<b>x</b> & y" })("derouter");
  assert.match(text, /&lt;b&gt;x&lt;\/b&gt; &amp; y/);
  assert.match(notify.messages.broadcast("1 < 2")("site"), /1 &lt; 2/);
});

test("an order approval reports the plan it created", async () => {
  seedPlanRow();
  user("u1", { telegram: "111" });
  plan("up1", "u1", { endsIn: 30 * DAY, orderId: "o1", total: 5e9, remaining: 5e9 });
  plan("up2", "u1", { startsIn: 30 * DAY, endsIn: 60 * DAY, orderId: "o1", total: 5e9, remaining: 5e9 });
  assert.equal((await notify.notifyOrderApproved("o1")).ok, true);
  assert.match(sent[0].text, /Thanh toán thành công/);
  assert.match(sent[0].text, /Go/);
  assert.match(sent[0].text, /\$10\.00/);
});

// ── Login IPs ────────────────────────────────────────────────────────────────

test("only a login from an IP never used to sign in or register counts as new", () => {
  user("u1");
  assert.equal(notify.isNewLoginIpSync(db, "u1", "203.0.113.9"), false); // first sign-in
  db.run(`INSERT INTO activityLog(userId, action, ip, createdAt) VALUES('u1', 'register', '198.51.100.1', '2026-01-01')`);
  assert.equal(notify.isNewLoginIpSync(db, "u1", "203.0.113.9"), false); // still no earlier login
  db.run(`INSERT INTO activityLog(userId, action, ip, createdAt) VALUES('u1', 'login', '198.51.100.1', '2026-01-02')`);
  assert.equal(notify.isNewLoginIpSync(db, "u1", "198.51.100.1"), false);
  assert.equal(notify.isNewLoginIpSync(db, "u1", "203.0.113.9"), true);
  assert.equal(notify.isNewLoginIpSync(db, "u1", null), false);
});

// ── Reminders ────────────────────────────────────────────────────────────────

test("expiry reminders: 3 days, then 24 hours, never with a plan running past it", () => {
  seedPlanRow();
  user("u1", { telegram: "1" });
  user("u2", { telegram: "2" });
  user("u3", { telegram: "3" });
  user("u4"); // not linked
  plan("a", "u1", { endsIn: 2.5 * DAY });
  plan("b", "u2", { endsIn: 0.5 * DAY });
  plan("c", "u3", { endsIn: 2 * DAY });
  plan("c2", "u3", { startsIn: 2 * DAY, endsIn: 32 * DAY }); // queued renewal
  plan("d", "u4", { endsIn: DAY });
  const due = reminders.findDueRemindersSync(db).filter((r) => r.kind.startsWith("expire"));
  assert.deepEqual(due.map((r) => [r.refId.split(":")[0], r.kind]).sort(), [["a", "expire_3d"], ["b", "expire_1d"]]);
});

test("no expiry reminder for a plan no longer than the window, or for a suspended account", () => {
  user("u1", { telegram: "1" });
  user("u2", { telegram: "2", status: "suspended" });
  plan("short", "u1", { startsIn: -60_000, endsIn: 2 * DAY }); // a 2-day gift: no 3-day warning
  plan("tiny", "u1", { startsIn: -60_000, endsIn: 0.9 * DAY }); // a 1-day grant: nothing at all
  plan("s", "u2", { endsIn: 0.5 * DAY });
  assert.deepEqual(reminders.findDueRemindersSync(db), []);
  // The 2-day gift still gets the 24-hour warning once it is that close.
  assert.deepEqual(
    reminders.findDueRemindersSync(db, Date.now() + 1.2 * DAY).map((r) => [r.refId.split(":")[0], r.kind]),
    [["short", "expire_1d"]]
  );
});

test("3-day then 24-hour reminders; an extended plan is reminded again", async () => {
  user("u1", { telegram: "1" });
  plan("a", "u1", { endsIn: 2.5 * DAY });
  assert.equal(await reminders.runReminderTick(), 1);
  assert.match(sent[0].text, /sắp hết hạn \(3 ngày\)/);
  assert.equal(await reminders.runReminderTick(Date.now() + 2 * DAY), 1);
  assert.match(sent[1].text, /24 giờ/);
  assert.equal(await reminders.runReminderTick(Date.now() + 2.1 * DAY), 0);
  // Admin extends the plan by 30 days: the new end date is a new reminder.
  db.run(`UPDATE userPlans SET expiresAt = ? WHERE id = 'a'`, [new Date(Date.now() + 32 * DAY).toISOString()]);
  assert.equal(await reminders.runReminderTick(Date.now() + 30 * DAY), 1);
});

test("low credit is judged across the account's running plans", () => {
  user("u1", { telegram: "1" });
  user("u2", { telegram: "2" });
  user("u3", { telegram: "3" });
  plan("a", "u1", { endsIn: 20 * DAY, total: 10e9, remaining: 0.5e9 });
  plan("b1", "u2", { endsIn: 20 * DAY, total: 10e9, remaining: 0, status: "exhausted" });
  plan("b2", "u2", { endsIn: 20 * DAY, total: 10e9, remaining: 9e9 });
  plan("c", "u3", { endsIn: 20 * DAY, total: 0, remaining: 0, unlimited: 1 });
  const due = reminders.findDueRemindersSync(db).filter((r) => r.kind === "credit_low");
  assert.deepEqual(due.map((r) => r.userId), ["u1"]);
});

test("credit_low is not repeated when an old plan drops out, only after a purchase", () => {
  user("u1", { telegram: "1" });
  plan("old", "u1", { endsIn: 1 * DAY, total: 10e9, remaining: 0, status: "exhausted" });
  db.run(`UPDATE userPlans SET createdAt = '2026-01-01T00:00:00.000Z' WHERE id = 'old'`);
  plan("cur", "u1", { endsIn: 20 * DAY, total: 10e9, remaining: 1e9 });
  const first = reminders.findDueRemindersSync(db).find((r) => r.kind === "credit_low");
  db.run(`INSERT INTO telegramNotices(userId, kind, refId, createdAt) VALUES('u1', 'credit_low', ?, 'x')`, [first.refId]);
  db.run(`DELETE FROM userPlans WHERE id = 'old'`); // expired out of the running set
  assert.equal(reminders.findDueRemindersSync(db).filter((r) => r.kind === "credit_low").length, 0);
  plan("new", "u1", { endsIn: 30 * DAY, total: 1e9, remaining: 0.05e9 }); // bought more, spent it
  db.run(`UPDATE userPlans SET createdAt = '2099-01-01T00:00:00.000Z' WHERE id = 'new'`);
  assert.equal(reminders.findDueRemindersSync(db).filter((r) => r.kind === "credit_low").length, 1);
});

test("a reminder is sent once; an opted-out one is settled without sending", async () => {
  seedPlanRow();
  user("u1", { telegram: "1" });
  user("u2", { telegram: "2", prefs: { expiry: false } });
  plan("a", "u1", { endsIn: 0.5 * DAY });
  plan("b", "u2", { endsIn: 0.5 * DAY });
  assert.equal(await reminders.runReminderTick(), 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /hết hạn trong 24 giờ/);
  assert.equal(await reminders.runReminderTick(), 0);
  assert.equal(sent.length, 1);
  // The 1-day reminder also settles the 3-day one.
  assert.ok(db.get(`SELECT 1 AS x FROM telegramNotices WHERE kind = 'expire_3d' AND refId LIKE 'a:%'`));
});

test("a reminder that failed in transit is retried on the next tick", async () => {
  user("u1", { telegram: "1" });
  plan("a", "u1", { endsIn: 0.5 * DAY });
  reply = () => ({ ok: false, reason: "network_error" });
  await reminders.runReminderTick();
  reply = () => ({ ok: true });
  assert.equal(await reminders.runReminderTick(), 1);
});

// ── Broadcasts ───────────────────────────────────────────────────────────────

test("a broadcast reaches linked, active, opted-in, reachable accounts only", async () => {
  user("u1", { telegram: "1" });
  user("u2", { telegram: "2", prefs: { announcements: false } });
  user("u3", { telegram: "3", blocked: new Date().toISOString() });
  user("u4", { telegram: "4", status: "suspended" });
  user("u5");
  user("u6", { telegram: "6" });
  reply = (chatId) => (chatId === "6" ? { ok: false, blocked: true, reason: "blocked" } : { ok: true });

  assert.deepEqual(broadcast.audienceStatsSync(db), { linked: 5, blocked: 1, recipients: 2 });
  const started = await broadcast.startBroadcast({ text: "  Bảo trì <23:00>  ", createdBy: "admin:1" });
  assert.equal(started.ok, true);
  await broadcast.waitForBroadcastForTests();

  assert.deepEqual(sent.map((m) => m.chatId).sort(), ["1", "6"]);
  assert.match(sent[0].text, /Bảo trì &lt;23:00&gt;/);
  const row = db.get(`SELECT status, total, sent, failed, text FROM telegramBroadcasts`);
  assert.deepEqual(row, { status: "done", total: 2, sent: 1, failed: 1, text: "Bảo trì <23:00>" });
  assert.equal(broadcast.listBroadcastsSync(db)[0].status, "done");
});

test("only one broadcast runs at a time; a row left sending shows as interrupted", async () => {
  user("u1", { telegram: "1" });
  const first = await broadcast.startBroadcast({ text: "one" });
  const second = await broadcast.startBroadcast({ text: "two" });
  assert.equal(first.ok, true);
  assert.equal(second.status, 409);
  await broadcast.waitForBroadcastForTests();
  db.run(`INSERT INTO telegramBroadcasts(id, text, createdAt, status, total) VALUES('old', 'x', '2026-01-01', 'sending', 5)`);
  assert.equal(broadcast.listBroadcastsSync(db).find((b) => b.id === "old").status, "interrupted");
});

test("an opt-out during a broadcast is skipped, not failed", async () => {
  user("u1", { telegram: "1" });
  user("u2", { telegram: "2" });
  reply = (chatId) => {
    // u2 turns announcements off while the broadcast is running.
    db.run(`UPDATE users SET telegramNotifyPrefs = '{"announcements":false}' WHERE id = 'u2'`);
    return { ok: true, chatId };
  };
  await broadcast.startBroadcast({ text: "hi" });
  await broadcast.waitForBroadcastForTests();
  const row = db.get(`SELECT sent, failed, skipped FROM telegramBroadcasts`);
  assert.deepEqual(row, { sent: 1, failed: 0, skipped: 1 });
});

test("an admin grant and a credit-only gift are announced", async () => {
  seedPlanRow();
  user("u1", { telegram: "1" });
  plan("g1", "u1", { endsIn: 30 * DAY, total: 3e9, remaining: 3e9 });
  db.run(`UPDATE userPlans SET planId = NULL WHERE id = 'g1'`);
  assert.equal((await notify.notifyPlanReceived("g1", "gift")).ok, true);
  assert.match(sent[0].text, /Nhận quà thành công/);
  assert.doesNotMatch(sent[0].text, /Gói:/);
  plan("g2", "u1", { endsIn: 30 * DAY });
  await notify.notifyGiftAssignments([{ ok: true, userPlanId: "g2" }, { ok: false }]);
  assert.equal(sent.length, 2);
  assert.equal((await notify.notifyPlanReceived("g2", "admin")).ok, true);
  assert.match(sent[2].text, /Bạn được tặng gói/);
});

test("an empty or oversized broadcast is refused", async () => {
  assert.equal((await broadcast.startBroadcast({ text: "   " })).status, 400);
  assert.equal((await broadcast.startBroadcast({ text: "x".repeat(broadcast.MAX_BROADCAST_LENGTH + 1) })).status, 400);
  assert.equal((await broadcast.startBroadcast({ text: "hi" })).error, "Chưa có khách nào nhận được thông báo");
});
