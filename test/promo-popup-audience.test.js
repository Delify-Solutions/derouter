// The popup inside /account is only for new accounts (spec promo-popup
// "Where the popup shows"): no purchase yet and the popup's code not redeemed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-promo-audience-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const { isNewAccountForPromoSync } = await import("../src/lib/promo/newAccount.js");

let db;
const now = new Date().toISOString();
before(async () => {
  db = await getAdapter();
  for (const id of ["fresh", "buyer", "gifted", "redeemed"]) {
    db.run(`INSERT INTO users(id, email, passwordHash, status, createdAt) VALUES(?, ?, 'x', 'active', ?)`, [id, `${id}@t.io`, now]);
  }
  const plan = (id, userId, source) => db.run(
    `INSERT INTO userPlans(id, userId, planId, source, creditTotalNanoUsd, creditRemainingNanoUsd, startsAt, expiresAt, status, createdAt)
     VALUES(?, ?, NULL, ?, 1, 1, ?, ?, 'active', ?)`,
    [id, userId, source, now, now, now]
  );
  plan("p1", "buyer", "purchase");
  plan("p2", "gifted", "gift");
  db.run(`INSERT INTO giftCodes(id, code, grantKind, creditNanoUsd, createdAt) VALUES('g1', 'WELCOME2026', 'credit', 1, ?)`, [now]);
  db.run(`INSERT INTO giftRedemptions(id, giftId, userId, redeemedAt) VALUES('r1', 'g1', 'redeemed', ?)`, [now]);
  // An older code stored with its separator.
  db.run(`INSERT INTO users(id, email, passwordHash, status, createdAt) VALUES('dashed', 'dashed@t.io', 'x', 'active', ?)`, [now]);
  db.run(`INSERT INTO giftCodes(id, code, grantKind, creditNanoUsd, createdAt) VALUES('g2', 'WEL-COME', 'credit', 1, ?)`, [now]);
  db.run(`INSERT INTO giftRedemptions(id, giftId, userId, redeemedAt) VALUES('r2', 'g2', 'dashed', ?)`, [now]);
});
after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test("a fresh account sees it; a buyer or someone who redeemed the popup code does not", () => {
  assert.equal(isNewAccountForPromoSync(db, "fresh", "welcome-2026"), true);
  assert.equal(isNewAccountForPromoSync(db, "buyer", "WELCOME2026"), false, "bought a plan");
  assert.equal(isNewAccountForPromoSync(db, "gifted", "WELCOME2026"), true, "a gift is not a purchase");
  assert.equal(isNewAccountForPromoSync(db, "redeemed", "WELCOME2026"), false, "already took this code");
  assert.equal(isNewAccountForPromoSync(db, "redeemed", ""), true, "a popup without a code only checks purchases");
  assert.equal(isNewAccountForPromoSync(db, "", "WELCOME2026"), false);
  assert.equal(isNewAccountForPromoSync(db, "dashed", "WELCOME"), false, "a code stored with dashes still matches");
});
