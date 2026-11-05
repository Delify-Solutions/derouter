// Gift codes with no total cap (change gift-unlimited).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-gift-unlimited-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const gifts = await import("../src/lib/db/repos/giftRepo.js");
const { giftStatusOf, giftExhausted } = await import("../src/lib/gift/window.js");

const USD = (n) => Math.round(n * 1e9);
let db;

before(async () => { db = await getAdapter(); });
after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(() => {
  for (const table of ["giftRedemptions", "giftCodes", "creditLedger", "userPlans", "users"]) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* ignore */ }
  }
  const now = new Date().toISOString();
  for (let i = 1; i <= 4; i += 1) {
    db.run(
      `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
       VALUES(?, ?, 'x', NULL, NULL, 'active', 0, ?, ?)`,
      [`u${i}`, `u${i}@test.local`, now, now]
    );
  }
});

const redeem = (userId, code) => db.transaction(() => gifts.redeemGiftCode(db, { userId, code }));

test("an unlimited code never runs out; the per-account limit still holds", async () => {
  const gift = await gifts.createGiftCode({ code: "OPENALL", creditNanoUsd: USD(1), durationDays: 7, unlimitedRedemptions: true, maxRedemptions: 1 });
  assert.equal(gift.unlimitedRedemptions, true);
  for (const id of ["u1", "u2", "u3", "u4"]) assert.equal(redeem(id, "OPENALL").ok, true, id);
  assert.equal(redeem("u1", "OPENALL").reason, "already_redeemed");
  const row = db.get(`SELECT * FROM giftCodes WHERE id = ?`, [gift.id]);
  assert.equal(row.redeemedCount, 4);
  assert.equal(giftExhausted(row), false);
  assert.equal(giftStatusOf(row), "active");
  assert.equal(gifts.listAvailableGiftsSync(db, "u1").length, 0, "u1 used its one");
});

test("a capped code still runs out, and going back to capped needs a total above the uses", async () => {
  const gift = await gifts.createGiftCode({ code: "CAPPED", creditNanoUsd: USD(1), durationDays: 7, maxRedemptions: 1 });
  assert.equal(redeem("u1", "CAPPED").ok, true);
  assert.equal(redeem("u2", "CAPPED").reason, "exhausted");

  await gifts.updateGiftCode(gift.id, { unlimitedRedemptions: true });
  assert.equal(redeem("u2", "CAPPED").ok, true);
  assert.equal(redeem("u3", "CAPPED").ok, true);

  await assert.rejects(gifts.updateGiftCode(gift.id, { unlimitedRedemptions: false, maxRedemptions: 2 }), /không được nhỏ hơn/);
  const back = await gifts.updateGiftCode(gift.id, { unlimitedRedemptions: false, maxRedemptions: 3 });
  assert.equal(back.unlimitedRedemptions, false);
  assert.equal(redeem("u4", "CAPPED").reason, "exhausted");
});

test("an unlimited code is listed with no remaining count", async () => {
  await gifts.createGiftCode({ code: "LISTEDALL", creditNanoUsd: USD(1), durationDays: 7, unlimitedRedemptions: true, listed: true });
  const [entry] = gifts.listAvailableGiftsSync(db, "u1");
  assert.equal(entry.code, "LISTEDALL");
  assert.equal(entry.remaining, null);
});

test("an unlimited code stays advertisable and checkable past its stored total", async () => {
  const { eligibleReferralGiftSync } = await import("../src/lib/affiliate/gift.js");
  const welcome = await gifts.createGiftCode({ code: "WELCOMEALL", creditNanoUsd: USD(1), durationDays: 7, unlimitedRedemptions: true, newUserOnly: true });
  db.run(`UPDATE giftCodes SET redeemedCount = 50 WHERE id = ?`, [welcome.id]);
  assert.ok(eligibleReferralGiftSync(db, welcome.id), "never exhausted for the referral advert");

  await gifts.createGiftCode({ code: "CHANNELALL", creditNanoUsd: USD(1), durationDays: 7, unlimitedRedemptions: true, channelJoinOnly: true });
  db.run(`UPDATE giftCodes SET redeemedCount = 50 WHERE code = 'CHANNELALL'`);
  db.run(`UPDATE users SET telegramUserId = '777' WHERE id = 'u1'`);
  assert.equal(gifts.giftRequirementSync(db, { userId: "u1", code: "CHANNELALL" }).checkChannel, true);
});

test("an unlimited code ignores a bad max; a capped one refuses it", async () => {
  const gift = await gifts.createGiftCode({ code: "MAXCHECK", creditNanoUsd: USD(1), durationDays: 7, unlimitedRedemptions: true });
  const kept = await gifts.updateGiftCode(gift.id, { unlimitedRedemptions: true, maxRedemptions: 0 });
  assert.equal(kept.unlimitedRedemptions, true);
  await assert.rejects(gifts.updateGiftCode(gift.id, { unlimitedRedemptions: false, maxRedemptions: 0 }), /at least 1/);
});
