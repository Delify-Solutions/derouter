// Channel-join gift codes and the customer's "Mã có thể sử dụng" list
// (change channel-gift).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-channel-gift-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const gifts = await import("../src/lib/db/repos/giftRepo.js");
const link = await import("../src/lib/db/repos/telegramLinkRepo.js");
const member = await import("../src/lib/telegram/channelMember.js");

const USD = (n) => Math.round(n * 1e9);
let db;

before(async () => { db = await getAdapter(); });
after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(() => {
  for (const table of ["giftRedemptions", "giftCodes", "creditLedger", "userPlans", "plans", "users", "telegramLinkTokens"]) {
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

function linkTelegram(userId, telegramId) {
  const { token } = link.issueLinkTokenSync(db, userId);
  return link.consumeLinkTokenSync(db, token, { id: telegramId, username: `user${telegramId}` });
}

const channelCode = (overrides = {}) =>
  gifts.createGiftCode({ code: "JOINCHANNEL", creditNanoUsd: USD(10), durationDays: 30, maxRedemptions: 100, channelJoinOnly: true, ...overrides });

const redeem = (userId, code, verified = null) =>
  db.transaction(() => gifts.redeemGiftCode(db, { userId, code, channelMemberTelegramUserId: verified }));

test("a channel-join code is one per account and never also a new-user code", async () => {
  const gift = await channelCode({ perUserLimit: 5 });
  assert.equal(gift.channelJoinOnly, true);
  assert.equal(gift.perUserLimit, 1, "pinned to one per account");
  await assert.rejects(channelCode({ code: "BOTHKINDS", newUserOnly: true }), /một loại/);
  await assert.rejects(gifts.updateGiftCode(gift.id, { newUserOnly: true }), /một loại/);
});

test("a channel-join code needs a link and verified membership of that same Telegram user", async () => {
  await channelCode();
  assert.equal(redeem("u1", "JOINCHANNEL").reason, "telegram_required");

  linkTelegram("u1", 501);
  assert.equal(redeem("u1", "JOINCHANNEL").reason, "channel_required", "not verified in the channel");
  assert.equal(redeem("u1", "JOINCHANNEL", "999").reason, "channel_required", "another Telegram user was verified");

  const ok = redeem("u1", "JOINCHANNEL", "501");
  assert.equal(ok.ok, true);
  assert.equal(ok.userPlan.creditTotalNanoUsd, USD(10));
});

test("any account may take it, old or new, but each Telegram user only once", async () => {
  await channelCode();
  // u1 already bought a plan: not a new account, still allowed.
  db.run(
    `INSERT INTO userPlans(id, userId, planId, source, status, creditTotalNanoUsd, creditRemainingNanoUsd, startsAt, expiresAt, createdAt)
     VALUES('bought', 'u1', NULL, 'purchase', 'active', 1, 1, ?, ?, ?)`,
    [new Date().toISOString(), new Date(Date.now() + 86400000).toISOString(), new Date().toISOString()]
  );
  linkTelegram("u1", 501);
  assert.equal(redeem("u1", "JOINCHANNEL", "501").ok, true);
  assert.equal(redeem("u1", "JOINCHANNEL", "501").reason, "already_redeemed");

  // The same Telegram user moved to another account cannot take it again.
  link.unlinkTelegramSync(db, "u1");
  linkTelegram("u2", 501);
  assert.equal(redeem("u2", "JOINCHANNEL", "501").reason, "telegram_channel_used");

  // Another Telegram user on another account still can.
  linkTelegram("u3", 777);
  assert.equal(redeem("u3", "JOINCHANNEL", "777").ok, true);
});

test("an admin assignment skips the channel check", async () => {
  const gift = await channelCode();
  const res = gifts.assignGiftCodeSync(db, gift.id, { userIds: ["u2"], actor: "admin:test" });
  assert.equal(res.results[0].ok, true);
});

test("available list: listed live codes this account can still take, with what they need", async () => {
  const listedChannel = await channelCode({ listed: true });
  await gifts.createGiftCode({ code: "HIDDEN10", creditNanoUsd: USD(1), durationDays: 7, maxRedemptions: 10 });
  const welcome = await gifts.createGiftCode({ code: "WELCOME1", creditNanoUsd: USD(2), durationDays: 7, maxRedemptions: 10, newUserOnly: true, listed: true });
  await gifts.createGiftCode({ code: "EXPIRED1", creditNanoUsd: USD(1), durationDays: 7, listed: true, expiresAt: new Date(Date.now() - 1000).toISOString() });
  await gifts.createGiftCode({ code: "OFFCODE1", creditNanoUsd: USD(1), durationDays: 7, listed: true, isActive: false });

  let list = gifts.listAvailableGiftsSync(db, "u1");
  assert.deepEqual(list.map((g) => g.code).sort(), ["JOINCHANNEL", "WELCOME1"]);
  const ch = list.find((g) => g.code === "JOINCHANNEL");
  assert.equal(ch.kind, "channel");
  assert.equal(ch.needsTelegram, true);
  assert.equal(ch.grant.creditNanoUsd, USD(10));
  assert.equal(list.find((g) => g.code === "WELCOME1").kind, "new_user");

  linkTelegram("u1", 501);
  list = gifts.listAvailableGiftsSync(db, "u1");
  assert.equal(list.find((g) => g.code === "JOINCHANNEL").needsTelegram, false);

  // Taken: gone from the list, also the welcome code once used.
  assert.equal(redeem("u1", "JOINCHANNEL", "501").ok, true);
  assert.equal(redeem("u1", "WELCOME1").ok, true);
  assert.deepEqual(gifts.listAvailableGiftsSync(db, "u1"), []);

  // The unlisted lookup (welcome offer) still sees an unlisted channel code.
  await gifts.updateGiftCode(listedChannel.id, { listed: false });
  linkTelegram("u2", 888);
  assert.deepEqual(gifts.listAvailableGiftsSync(db, "u2", { listedOnly: false, channelOnly: true }).map((g) => g.code), ["JOINCHANNEL"]);
  assert.ok(welcome.listed);
});

test("giftRequirementSync tells the route a channel code apart", async () => {
  await channelCode();
  linkTelegram("u1", 501);
  const req = gifts.giftRequirementSync(db, { userId: "u1", code: "join-channel" });
  assert.equal(req.channelJoinOnly, true);
  assert.equal(req.telegramUserId, "501");
  assert.equal(gifts.giftRequirementSync(db, { userId: "u1", code: "NOPE" }), null);
});

// ── Telegram membership check ─────────────────────────────────────────────────

const reply = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test("chat id: explicit setting, else the public link's username", () => {
  assert.equal(member.channelChatIdOf({ telegramChannelUrl: "https://t.me/delify_ai" }), "@delify_ai");
  assert.equal(member.channelChatIdOf({ telegramChannelUrl: "https://t.me/+AbCdEf123" }), "", "private invite has no username");
  assert.equal(member.channelChatIdOf({ telegramChannelUrl: "https://t.me/+AbC", telegramChannelChatId: "-1001234567890" }), "-1001234567890");
  assert.deepEqual(member.normalizeChannelChatId("delify_ai"), { value: "@delify_ai" });
  assert.ok(member.normalizeChannelChatId("bad id!").error);
});

test("membership statuses map to member / not member / unavailable", async () => {
  const check = (impl) => member.checkChannelMember("1:t", "@c", "501", { fetchImpl: impl });
  assert.deepEqual(await check(reply(200, { ok: true, result: { status: "member" } })), { ok: true, member: true });
  assert.deepEqual(await check(reply(200, { ok: true, result: { status: "creator" } })), { ok: true, member: true });
  assert.deepEqual(await check(reply(200, { ok: true, result: { status: "left" } })), { ok: true, member: false });
  assert.deepEqual(await check(reply(200, { ok: true, result: { status: "kicked" } })), { ok: true, member: false });
  assert.deepEqual(await check(reply(200, { ok: true, result: { status: "restricted", is_member: true } })), { ok: true, member: true });
  assert.deepEqual(await check(reply(400, { ok: false, description: "Bad Request: user not found" })), { ok: true, member: false });
  assert.equal((await check(reply(400, { ok: false, description: "Bad Request: member list is inaccessible" }))).reason, "chat_unavailable");
  assert.equal((await check(reply(400, { ok: false, description: "Bad Request: chat not found" }))).reason, "chat_unavailable");
  assert.equal((await check(async () => { throw new Error("x"); })).reason, "network_error");
  assert.equal((await member.checkChannelMember("", "@c", "1")).reason, "not_configured");
});

test("checkChannel is false whenever the transaction would refuse anyway", async () => {
  const gift = await channelCode({ maxRedemptions: 1 });
  assert.equal(gifts.giftRequirementSync(db, { userId: "u1", code: "JOINCHANNEL" }).checkChannel, false, "no link");
  linkTelegram("u1", 501);
  assert.equal(gifts.giftRequirementSync(db, { userId: "u1", code: "JOINCHANNEL" }).checkChannel, true);

  await gifts.updateGiftCode(gift.id, { isActive: false });
  assert.equal(gifts.giftRequirementSync(db, { userId: "u1", code: "JOINCHANNEL" }).checkChannel, false, "code off");
  await gifts.updateGiftCode(gift.id, { isActive: true, expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(gifts.giftRequirementSync(db, { userId: "u1", code: "JOINCHANNEL" }).checkChannel, false, "expired");
  await gifts.updateGiftCode(gift.id, { expiresAt: "" });

  assert.equal(redeem("u1", "JOINCHANNEL", "501").ok, true);
  assert.equal(gifts.giftRequirementSync(db, { userId: "u1", code: "JOINCHANNEL" }).checkChannel, false, "taken / used up");
  linkTelegram("u2", 502);
  assert.equal(gifts.giftRequirementSync(db, { userId: "u2", code: "JOINCHANNEL" }).checkChannel, false, "exhausted");
});

test("channel codes are left out of the list when the check is not configured", async () => {
  await channelCode({ listed: true });
  linkTelegram("u1", 501);
  assert.equal(gifts.listAvailableGiftsSync(db, "u1").length, 1);
  assert.equal(gifts.listAvailableGiftsSync(db, "u1", { includeChannel: false }).length, 0);
  assert.equal(member.channelCheckConfigured({ telegramBotToken: "1:t", telegramChannelUrl: "https://t.me/delify_ai" }), true);
  assert.equal(member.channelCheckConfigured({ telegramChannelUrl: "https://t.me/delify_ai" }), false, "no bot token");
  assert.equal(member.channelCheckConfigured({ telegramBotToken: "1:t", telegramChannelUrl: "https://t.me/+priv" }), false, "no chat id");
});

test("membership checks are spaced per account", () => {
  const t0 = 1_000_000;
  assert.equal(member.reserveMembershipCheck("acc-x", { now: t0 }), true);
  assert.equal(member.reserveMembershipCheck("acc-x", { now: t0 + 1000 }), false);
  assert.equal(member.reserveMembershipCheck("acc-y", { now: t0 + 1000 }), true, "other accounts are independent");
  assert.equal(member.reserveMembershipCheck("acc-x", { now: t0 + 3000 }), true);
});

test("remaining Telegram replies map safely", async () => {
  const check = (impl) => member.checkChannelMember("1:t", "@c", "501", { fetchImpl: impl });
  assert.deepEqual(await check(reply(200, { ok: true, result: { status: "restricted", is_member: false } })), { ok: true, member: false });
  assert.equal((await check(reply(429, { ok: false, parameters: { retry_after: 3 } }))).reason, "rate_limited");
  assert.equal((await check(reply(502, {}))).reason, "telegram_error");
  const notJson = async () => ({ ok: false, status: 500, json: async () => { throw new Error("html"); } });
  assert.equal((await check(notJson)).ok, false);

  const bot = (impl) => member.checkBotCanReadChannel("123:t", "@c", { fetchImpl: impl });
  assert.deepEqual(await bot(reply(200, { ok: true, result: { status: "administrator" } })), { ok: true });
  assert.equal((await bot(reply(200, { ok: true, result: { status: "member" } }))).reason, "bot_not_admin");
  assert.equal((await bot(reply(401, { ok: false }))).reason, "bad_token");
  assert.equal((await bot(reply(400, { ok: false, description: "chat not found" }))).reason, "chat_unavailable");
  assert.equal((await member.checkBotCanReadChannel("bad", "@c")).reason, "not_configured");
});
