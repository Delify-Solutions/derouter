// Telegram linking through a Mini App and new-user gift codes
// (specs telegram-link, gift-codes "New-user codes").
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-tg-gift-"));
// DATA_DIR must be set before the DB driver is imported.
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const billing = await import("../src/lib/db/repos/billingRepo.js");
const gifts = await import("../src/lib/db/repos/giftRepo.js");
const link = await import("../src/lib/db/repos/telegramLinkRepo.js");
const { verifyInitData, signInitData } = await import("../src/lib/telegram/initData.js");

const BOT_TOKEN = "123456:TEST-token";
const USD = (n) => Math.round(n * 1e9);
let db;

before(async () => { db = await getAdapter(); });
after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(() => {
  for (const table of ["giftRedemptions", "giftCodes", "creditLedger", "userPlans", "plans", "users", "userAuditLog", "telegramLinkTokens"]) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* table may not exist */ }
  }
  const now = new Date().toISOString();
  for (const id of ["u1", "u2", "u3"]) {
    db.run(
      `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
       VALUES(?, ?, 'x', NULL, NULL, 'active', 0, ?, ?)`,
      [id, `${id}@test.local`, now, now]
    );
  }
});

function initData(fields, token = BOT_TOKEN) {
  const params = new URLSearchParams(fields);
  params.set("hash", signInitData(params, token));
  return params.toString();
}

const nowSec = () => Math.floor(Date.now() / 1000);
const tgUser = (id, username = `user${id}`) => JSON.stringify({ id, first_name: "A", username });

function linkTelegram(userId, telegramId) {
  const { token } = link.issueLinkTokenSync(db, userId);
  return link.consumeLinkTokenSync(db, token, { id: telegramId, username: `user${telegramId}` });
}

const welcome = (overrides = {}) =>
  gifts.createGiftCode({ creditNanoUsd: USD(2), durationDays: 7, maxRedemptions: 100, newUserOnly: true, ...overrides });

// ── initData ──────────────────────────────────────────────────────────────────

test("valid init data yields the Telegram user and start_param", () => {
  const data = initData({ user: tgUser(42), auth_date: String(nowSec()), start_param: "tok_1", query_id: "q" });
  const result = verifyInitData(data, BOT_TOKEN);
  assert.equal(result.ok, true);
  assert.deepEqual(result.user, { id: "42", username: "user42", firstName: "A" });
  assert.equal(result.startParam, "tok_1");
});

test("init data signed with another token, or tampered with, is refused", () => {
  const forged = initData({ user: tgUser(42), auth_date: String(nowSec()) }, "999:other");
  assert.equal(verifyInitData(forged, BOT_TOKEN).reason, "bad_hash");

  const genuine = new URLSearchParams(initData({ user: tgUser(42), auth_date: String(nowSec()), start_param: "a" }));
  genuine.set("start_param", "b");
  assert.equal(verifyInitData(genuine.toString(), BOT_TOKEN).reason, "bad_hash");

  assert.equal(verifyInitData("user=x", BOT_TOKEN).reason, "malformed");
  assert.equal(verifyInitData("", BOT_TOKEN).reason, "malformed");
});

test("init data older than an hour is refused", () => {
  const old = initData({ user: tgUser(42), auth_date: String(nowSec() - 3601) });
  assert.equal(verifyInitData(old, BOT_TOKEN).reason, "expired");
});

// ── Link tokens ───────────────────────────────────────────────────────────────

test("a token links its account once and stores only its hash", () => {
  const { token, expiresAt } = link.issueLinkTokenSync(db, "u1");
  assert.ok(Date.parse(expiresAt) > Date.now());
  assert.equal(db.get(`SELECT COUNT(*) AS c FROM telegramLinkTokens WHERE tokenHash = ?`, [token]).c, 0);

  const first = link.consumeLinkTokenSync(db, token, { id: "42", username: "alice" });
  assert.equal(first.ok, true);
  assert.equal(first.userId, "u1");
  assert.deepEqual(
    { ...link.getTelegramLinkSync(db, "u1"), linkedAt: null },
    { linked: true, telegramUserId: "42", telegramUsername: "alice", linkedAt: null }
  );

  assert.equal(link.consumeLinkTokenSync(db, token, { id: "42" }).reason, "invalid_token");
});

test("an expired token or one replaced by a newer token is refused", () => {
  const { token: old } = link.issueLinkTokenSync(db, "u1");
  link.issueLinkTokenSync(db, "u1");
  assert.equal(link.consumeLinkTokenSync(db, old, { id: "42" }).reason, "invalid_token");

  const { token } = link.issueLinkTokenSync(db, "u2");
  const later = Date.now() + link.LINK_TOKEN_TTL_MS + 1000;
  assert.equal(link.consumeLinkTokenSync(db, token, { id: "43" }, { now: later }).reason, "invalid_token");
});

test("one Telegram user links to one account; unlinking frees it", () => {
  assert.equal(linkTelegram("u1", "42").ok, true);
  assert.equal(linkTelegram("u2", "42").reason, "telegram_taken");
  assert.equal(link.getTelegramLinkSync(db, "u1").telegramUserId, "42");

  // Re-linking the same account to another Telegram user replaces the link.
  assert.equal(linkTelegram("u1", "43").ok, true);
  assert.equal(link.getTelegramLinkSync(db, "u1").telegramUserId, "43");

  assert.equal(link.unlinkTelegramSync(db, "u1"), true);
  assert.equal(link.getTelegramLinkSync(db, "u1").linked, false);
  assert.equal(linkTelegram("u2", "43").ok, true);
});

test("the email shown in Telegram is masked", () => {
  assert.equal(link.maskEmail("alice@gmail.com"), "a***@gmail.com");
  assert.equal(link.maskEmail("bad"), "***");
});

// ── New-user codes ────────────────────────────────────────────────────────────

test("a new-user code is fixed at one redemption per account", async () => {
  const code = await welcome({ perUserLimit: 5 });
  assert.equal(code.newUserOnly, true);
  assert.equal(code.perUserLimit, 1);

  const plain = await gifts.createGiftCode({ creditNanoUsd: USD(1), durationDays: 7, perUserLimit: 3 });
  const updated = await gifts.updateGiftCode(plain.id, { newUserOnly: true });
  assert.equal(updated.newUserOnly, true);
  assert.equal(updated.perUserLimit, 1);
});

test("a new account without Telegram is asked to link it", async () => {
  const code = await welcome();
  const result = gifts.redeemGiftCode(db, { userId: "u1", code: code.code });
  assert.deepEqual(result, { ok: false, reason: "telegram_required" });
  assert.equal(db.get(`SELECT COUNT(*) AS c FROM userPlans`).c, 0);
});

test("a linked new account gets the gift and the redemption records its Telegram user", async () => {
  const code = await welcome();
  linkTelegram("u1", "42");
  const result = gifts.redeemGiftCode(db, { userId: "u1", code: code.code });
  assert.equal(result.ok, true);
  const row = db.get(`SELECT telegramUserId FROM giftRedemptions WHERE userId = 'u1'`);
  assert.equal(row.telegramUserId, "42");

  assert.equal(gifts.redeemGiftCode(db, { userId: "u1", code: code.code }).reason, "already_redeemed");
  const redemptions = await gifts.listRedemptions(code.id);
  assert.equal(redemptions[0].telegramUserId, "42");
  assert.equal(redemptions[0].telegramUsername, "user42");
});

test("one Telegram user claims one new-user code, across accounts and codes", async () => {
  const a = await welcome();
  const b = await welcome();
  linkTelegram("u1", "42");
  assert.equal(gifts.redeemGiftCode(db, { userId: "u1", code: a.code }).ok, true);

  // Same account, a different welcome code: it is no longer a new account.
  assert.equal(gifts.redeemGiftCode(db, { userId: "u1", code: b.code }).reason, "not_new_user");

  // Move the Telegram user to another account: the stored snapshot still counts.
  link.unlinkTelegramSync(db, "u1");
  linkTelegram("u2", "42");
  assert.equal(gifts.redeemGiftCode(db, { userId: "u2", code: a.code }).reason, "telegram_used");
  assert.equal(gifts.redeemGiftCode(db, { userId: "u2", code: b.code }).reason, "telegram_used");

  // A different Telegram user on a third account is fine.
  linkTelegram("u3", "77");
  assert.equal(gifts.redeemGiftCode(db, { userId: "u3", code: b.code }).ok, true);
});

test("an account that bought a plan is not new, and is told so before being asked to link", async () => {
  const code = await welcome();
  const p = await billing.createPlan({ code: "go", name: "Go", priceNanoUsd: USD(1), priceVnd: 10000, creditNanoUsd: USD(10), durationDays: 30 });
  billing.grantUserPlan(db, {
    userId: "u1", planId: p.id, orderId: "o1", source: "purchase", creditNanoUsd: USD(10), durationDays: 30, limits: [],
  });
  assert.equal(gifts.redeemGiftCode(db, { userId: "u1", code: code.code }).reason, "not_new_user");
});

test("a gift received another way does not make the account old", async () => {
  const plainCode = await gifts.createGiftCode({ creditNanoUsd: USD(1), durationDays: 7 });
  assert.equal(gifts.redeemGiftCode(db, { userId: "u1", code: plainCode.code }).ok, true);
  const code = await welcome();
  linkTelegram("u1", "42");
  assert.equal(gifts.redeemGiftCode(db, { userId: "u1", code: code.code }).ok, true);
});

test("an admin assignment skips the new-user conditions but uses up the Telegram claim", async () => {
  const code = await welcome();
  linkTelegram("u2", "42");
  const result = gifts.assignGiftCodeSync(db, code.id, { userIds: ["u1", "u2"], actor: "admin" });
  assert.deepEqual(result.results.map((r) => r.ok), [true, true]);

  link.unlinkTelegramSync(db, "u2");
  linkTelegram("u3", "42");
  const other = await welcome();
  assert.equal(gifts.redeemGiftCode(db, { userId: "u3", code: other.code }).reason, "telegram_used");
});
