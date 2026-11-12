// Models & notifications (change models-notifications): discount reasons, the
// web inbox, announcements and the Telegram channel link.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-models-notifications-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const inbox = await import("../src/lib/notify/inbox.js");
const notify = await import("../src/lib/notify/customerTelegram.js");
const { normalizeChannelUrl, channelUrlOf } = await import("../src/lib/telegram/channel.js");
const discounts = await import("../src/lib/billing/discounts.js");
const repo = await import("../src/lib/db/repos/modelDiscountsRepo.js");
const { reasonsLabel } = await import("../src/shared/utils/discountFormat.js");

let db;
const T0 = Date.UTC(2026, 10, 1, 8, 0, 0);
const at = (ms) => new Date(ms).toISOString();
const DAY = 86_400_000;

before(async () => { db = await getAdapter(); });
after(() => {
  notify.setTelegramTransportForTests(null);
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(() => {
  for (const t of ["users", "announcements", "customerNotifications", "modelDiscounts", "combos", "settings"]) {
    try { db.run(`DELETE FROM ${t}`); } catch { /* ignore */ }
  }
});

function user(id, { createdAt = at(T0), telegram = null } = {}) {
  db.run(
    `INSERT INTO users(id, email, passwordHash, status, overdraftNanoUsd, telegramUserId, createdAt, updatedAt)
     VALUES(?, ?, 'x', 'active', 0, ?, ?, ?)`,
    [id, `${id}@t.io`, telegram, createdAt, createdAt]
  );
}

// ── Discount reasons ─────────────────────────────────────────────────────────

test("discount reasons: distinct labels in rule order, current labels by id", async () => {
  db.run(`INSERT INTO combos(id, name, kind, models, meta, createdAt, updatedAt) VALUES('c1', 'gpt', 'llm', '[]', '{}', ?, ?)`, [at(T0), at(T0)]);
  const a = discounts.createDiscountSync(db, { scopeType: "combo", scopeId: "gpt", percent: "10", label: "Black Friday" });
  const b = discounts.createDiscountSync(db, { scopeType: "combo", scopeId: "gpt", percent: "5", label: "  " });
  const c = discounts.createDiscountSync(db, { scopeType: "combo", scopeId: "gpt", percent: "5", label: "Black Friday" });
  assert.ok(a.ok && b.ok && c.ok);
  const found = await repo.getActiveDiscountsForModels(["gpt", "none"]);
  assert.equal(found.get("gpt").totalBp, 2000);
  assert.deepEqual(found.get("gpt").reasons, ["Black Friday"], "blank labels dropped, duplicates merged");
  assert.equal(found.has("none"), false);

  const labels = await repo.getDiscountLabels([a.rule.id, b.rule.id, "gone"]);
  assert.deepEqual([...labels.entries()], [[a.rule.id, "Black Friday"]]);
  assert.equal(reasonsLabel(["A", " ", "B"]), "A · B");
  assert.equal(reasonsLabel(null), "");
});

// ── Inbox ────────────────────────────────────────────────────────────────────

test("personal notifications are stored as plain text, broadcasts are not", async () => {
  user("u1");
  const sent = [];
  notify.setTelegramTransportForTests(async (...args) => { sent.push(args); return { ok: true }; });
  db.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, [JSON.stringify({ siteName: "derouter" })]);

  // No bot token and no Telegram link: the web copy is still written.
  await notify.notifyCustomer("u1", "security", notify.messages.passwordChanged());
  await notify.notifyCustomer("u1", "announcements", notify.messages.broadcast("Hello <all>"));
  const rows = db.all(`SELECT kind, title, body FROM customerNotifications WHERE userId = 'u1'`);
  assert.equal(rows.length, 1, "the broadcast is an announcement, not a personal notice");
  assert.equal(rows[0].kind, "security");
  assert.equal(rows[0].title, "Mật khẩu đã thay đổi");
  assert.match(rows[0].body, /Các phiên đăng nhập khác/);
  assert.doesNotMatch(rows[0].body, /<|&lt;/);
  assert.equal(sent.length, 0, "nothing goes to Telegram without a bot and a link");

  assert.equal(inbox.plainText("<b>a &amp; b</b> &lt;x&gt;"), "a & b <x>");
  assert.equal(inbox.recordInboxSync(db, "u1", "announcements", "x"), false);
});

test("unread counts announcements and own notices after the last visit, not before sign-up", () => {
  user("old", { createdAt: at(T0) });
  inbox.createAnnouncementSync(db, { title: "Bảo trì", body: "23:00", important: false }, { now: at(T0 - DAY) });
  user("new", { createdAt: at(T0 + DAY) });
  inbox.createAnnouncementSync(db, { title: "Model mới", body: "gpt-6", important: true }, { now: at(T0 + 2 * DAY) });
  inbox.recordInboxSync(db, "old", "billing", "<b>derouter</b> · Đơn đã thanh toán\nGói: Go", { now: at(T0 + 2 * DAY) });

  const now = T0 + 3 * DAY;
  assert.equal(inbox.unreadCountSync(db, "old", { now }), 2, "one announcement after sign-up + one notice");
  assert.equal(inbox.unreadCountSync(db, "new", { now }), 1, "an announcement from before the account is not unread");

  const view = inbox.customerInboxSync(db, "old", { now });
  assert.deepEqual(view.announcements.map((a) => [a.title, a.unread, a.important]), [["Model mới", true, true], ["Bảo trì", false, false]]);
  assert.deepEqual(view.personal.map((n) => [n.title, n.body, n.unread]), [["Đơn đã thanh toán", "Gói: Go", true]]);

  inbox.markInboxSeenSync(db, "old", { now: at(now) });
  assert.equal(inbox.unreadCountSync(db, "old", { now }), 0);
  assert.equal(inbox.customerInboxSync(db, "new", { now }).personal.length, 0, "only the caller's own notices");
});

test("announcements: validation, edit, delete", () => {
  assert.match(inbox.validateAnnouncement({ title: "", body: "x" }).error, /tiêu đề/);
  assert.match(inbox.validateAnnouncement({ title: "x".repeat(121), body: "x" }).error, /120/);
  assert.match(inbox.validateAnnouncement({ title: "x", body: "" }).error, /nội dung/);
  assert.match(inbox.validateAnnouncement({ title: "x", body: "y".repeat(2001) }).error, /2000/);
  const ok = inbox.validateAnnouncement({ title: " A ", body: " B ", important: "yes" });
  assert.deepEqual(ok.value, { title: "A", body: "B", important: false }, "only a real true marks it important");

  const a = inbox.createAnnouncementSync(db, ok.value, { createdBy: "admin:t" });
  const edited = inbox.updateAnnouncementSync(db, a.id, { title: "A2", body: "B2", important: true });
  assert.deepEqual([edited.title, edited.body, edited.important], ["A2", "B2", true]);
  assert.equal(inbox.updateAnnouncementSync(db, "nope", ok.value), null);
  inbox.setAnnouncementBroadcastSync(db, a.id, "bc1");
  assert.equal(inbox.listAnnouncementsSync(db).rows[0].telegramBroadcastId, "bc1");
  assert.equal(inbox.deleteAnnouncementSync(db, a.id), true);
  assert.equal(inbox.deleteAnnouncementSync(db, a.id), false);
});

// ── Channel ──────────────────────────────────────────────────────────────────

test("channel link is normalised to https://t.me/... or refused", () => {
  assert.deepEqual(normalizeChannelUrl(""), { value: "" });
  assert.deepEqual(normalizeChannelUrl("t.me/derouter_news"), { value: "https://t.me/derouter_news" });
  assert.deepEqual(normalizeChannelUrl("http://telegram.me/derouter_news/"), { value: "https://t.me/derouter_news" });
  assert.deepEqual(normalizeChannelUrl("@derouter_news"), { value: "https://t.me/derouter_news" });
  assert.deepEqual(normalizeChannelUrl("https://t.me/+AbCdEf123"), { value: "https://t.me/+AbCdEf123" });
  for (const bad of ["https://evil.com/t.me/x", "javascript:alert(1)", "https://t.me/", "t.me/a b", "x".repeat(201)]) {
    assert.ok(normalizeChannelUrl(bad).error, bad);
  }
  assert.equal(channelUrlOf({ telegramChannelUrl: "javascript:alert(1)" }), "", "a bad stored value is never rendered");
  assert.equal(channelUrlOf({}), "");
});

test("marking read stops at the list shown, never moves back, and routine alerts skip the inbox", async () => {
  user("u1", { createdAt: at(T0) });
  inbox.recordInboxSync(db, "u1", "billing", "derouter · A", { now: at(T0 + 10) });
  inbox.markInboxSeenSync(db, "u1", { upTo: at(T0 + 20), now: at(T0 + 100) });
  inbox.recordInboxSync(db, "u1", "billing", "derouter · B", { now: at(T0 + 50) });
  assert.equal(inbox.unreadCountSync(db, "u1", { now: T0 + 100 }), 1, "B came after the list was shown");
  inbox.markInboxSeenSync(db, "u1", { upTo: at(T0 + 5), now: at(T0 + 100) });
  assert.equal(inbox.unreadCountSync(db, "u1", { now: T0 + 100 }), 1, "never moved backwards");

  await notify.notifyCustomer("u1", "security", notify.messages.login({ ip: "1.2.3.4", userAgent: "x" }), { inbox: false });
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM customerNotifications WHERE title LIKE '%Đăng nhập%'`).n, 0);

  inbox.recordInboxSync(db, "u1", "security", "A · B · Tiêu đề · có dấu\nx", { siteName: "A · B" });
  assert.equal(db.get(`SELECT title FROM customerNotifications ORDER BY id DESC LIMIT 1`).title, "Tiêu đề · có dấu");
});
