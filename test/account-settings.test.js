// Account settings (change account-settings): email change by confirmation link
// and the account history timeline.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-account-settings-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const change = await import("../src/lib/users/emailChange.js");
const history = await import("../src/lib/account/history.js");
const { hashToken } = await import("../src/lib/db/repos/userRepo.js");

let db;
const T0 = Date.UTC(2026, 10, 1, 8, 0, 0);
const at = (ms) => new Date(ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const USD = (n) => Math.round(n * 1e9);

before(async () => { db = await getAdapter(); });
after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(() => {
  for (const table of ["emailVerifications", "activityLog", "orders", "userPlans", "giftRedemptions", "giftCodes", "creditLedger", "plans", "users"]) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* ignore */ }
  }
});

function user(id, { email = `${id}@test.local`, status = "active" } = {}) {
  db.run(
    `INSERT INTO users(id, email, passwordHash, status, overdraftNanoUsd, createdAt, updatedAt, lastLoginAt)
     VALUES(?, ?, 'x', ?, 0, ?, ?, ?)`,
    [id, email, status, at(T0), at(T0), at(T0 + DAY)]
  );
}

// ── Email change ─────────────────────────────────────────────────────────────

test("validation refuses a malformed, identical or taken address", () => {
  user("u1", { email: "me@test.local" });
  user("u2", { email: "other@test.local" });
  const reason = (raw) => {
    try {
      change.validateNewEmailSync(db, "u1", raw);
      return "ok";
    } catch (error) {
      return error.reason;
    }
  };
  assert.equal(reason("not-an-email"), "bad_email");
  assert.equal(reason(" ME@test.local "), "same_email");
  assert.equal(reason("Other@Test.Local"), "taken");
  assert.equal(change.validateNewEmailSync(db, "u1", " New@Test.Local "), "new@test.local", "normalised");
});

test("the email changes only when the link is confirmed", () => {
  user("u1", { email: "me@test.local" });
  const issued = change.createEmailChangeSync(db, "u1", "new@test.local", { now: T0 });
  assert.equal(db.get(`SELECT email FROM users WHERE id = 'u1'`).email, "me@test.local", "unchanged before the link");
  assert.deepEqual(change.pendingEmailChangeSync(db, "u1", { now: T0 + MIN }), { newEmail: "new@test.local", expiresAt: at(T0 + DAY) });
  assert.equal(db.get(`SELECT tokenHash FROM emailVerifications`).tokenHash, hashToken(issued.token), "only the hash is stored");

  const result = db.transaction(() => change.confirmEmailChangeSync(db, issued.token, { now: T0 + HOUR }));
  assert.deepEqual(result, { ok: true, userId: "u1", oldEmail: "me@test.local", newEmail: "new@test.local", activated: false });
  assert.equal(db.get(`SELECT email FROM users WHERE id = 'u1'`).email, "new@test.local");
  assert.equal(change.pendingEmailChangeSync(db, "u1", { now: T0 + HOUR }), null);
  assert.deepEqual(
    db.transaction(() => change.confirmEmailChangeSync(db, issued.token, { now: T0 + HOUR })),
    { ok: false, reason: "invalid" },
    "single use"
  );
});

test("a new request invalidates the earlier link; cancel clears it", () => {
  user("u1");
  const first = change.createEmailChangeSync(db, "u1", "a@test.local", { now: T0 });
  const second = change.createEmailChangeSync(db, "u1", "b@test.local", { now: T0 + MIN });
  assert.deepEqual(db.transaction(() => change.confirmEmailChangeSync(db, first.token, { now: T0 + 2 * MIN })), { ok: false, reason: "invalid" });
  assert.equal(change.pendingEmailChangeSync(db, "u1", { now: T0 + 2 * MIN }).newEmail, "b@test.local");
  assert.equal(change.cancelEmailChangeSync(db, "u1"), 1);
  assert.deepEqual(db.transaction(() => change.confirmEmailChangeSync(db, second.token, { now: T0 + 3 * MIN })), { ok: false, reason: "invalid" });
});

test("an expired link, another purpose or a dropped token does nothing", () => {
  user("u1", { email: "me@test.local" });
  const issued = change.createEmailChangeSync(db, "u1", "new@test.local", { now: T0 });
  assert.equal(db.transaction(() => change.confirmEmailChangeSync(db, issued.token, { now: T0 + DAY + 1 })).reason, "invalid");

  const dropped = change.createEmailChangeSync(db, "u1", "new@test.local", { now: T0 });
  change.dropEmailChangeSync(db, dropped.id);
  assert.equal(db.transaction(() => change.confirmEmailChangeSync(db, dropped.token, { now: T0 + MIN })).reason, "invalid");

  const other = change.createEmailChangeSync(db, "u1", "new@test.local", { now: T0 });
  db.run(`UPDATE emailVerifications SET purpose = 'reset_password' WHERE id = ?`, [other.id]);
  assert.equal(db.transaction(() => change.confirmEmailChangeSync(db, other.token, { now: T0 + MIN })).reason, "invalid");
  assert.equal(db.get(`SELECT email FROM users WHERE id = 'u1'`).email, "me@test.local");
});

test("an address taken after the request is refused at confirm", () => {
  user("u1", { email: "me@test.local" });
  const issued = change.createEmailChangeSync(db, "u1", "new@test.local", { now: T0 });
  user("u2", { email: "new@test.local" });
  assert.deepEqual(db.transaction(() => change.confirmEmailChangeSync(db, issued.token, { now: T0 + MIN })), { ok: false, reason: "taken" });
  assert.equal(db.get(`SELECT email FROM users WHERE id = 'u1'`).email, "me@test.local");
});

test("confirming activates an unverified account but never a suspended one", () => {
  user("un", { status: "unverified" });
  user("su", { status: "suspended" });
  const a = change.createEmailChangeSync(db, "un", "un2@test.local", { now: T0 });
  const b = change.createEmailChangeSync(db, "su", "su2@test.local", { now: T0 });
  assert.equal(db.transaction(() => change.confirmEmailChangeSync(db, a.token, { now: T0 + MIN })).activated, true);
  assert.equal(db.get(`SELECT status FROM users WHERE id = 'un'`).status, "active");
  db.transaction(() => change.confirmEmailChangeSync(db, b.token, { now: T0 + MIN }));
  assert.deepEqual(db.get(`SELECT email, status FROM users WHERE id = 'su'`), { email: "su2@test.local", status: "suspended" });
});

// ── History ──────────────────────────────────────────────────────────────────

function activity(userId, action, ms, details = null) {
  db.run(
    `INSERT INTO activityLog(userId, action, ip, userAgent, details, createdAt) VALUES(?, ?, '1.2.3.4', 'Mozilla/5.0 Chrome/120 Safari/537', ?, ?)`,
    [userId, action, details ? JSON.stringify(details) : null, at(ms)]
  );
}

function plan(id = "p1") {
  db.run(
    `INSERT INTO plans(id, code, name, priceNanoUsd, creditNanoUsd, durationDays, isActive, createdAt, updatedAt)
     VALUES(?, ?, 'Go', ?, ?, 30, 1, ?, ?)`,
    [id, id, USD(10), USD(100), at(T0), at(T0)]
  );
}

function order(id, userId, ms, { status = "paid", currency = "VND", amount = 250000 } = {}) {
  db.run(
    `INSERT INTO orders(id, userId, planId, amountNanoUsd, creditNanoUsd, durationDays, status, method, payCurrency, payAmount, createdAt, paidAt)
     VALUES(?, ?, 'p1', ?, ?, 30, ?, 'vietqr', ?, ?, ?, ?)`,
    [id, userId, USD(10), USD(100), status, currency, amount, at(ms), status === "paid" ? at(ms + MIN) : null]
  );
}

function grant(id, userId, ms, { source = "purchase", expiresMs = ms + 30 * DAY, status = "active" } = {}) {
  db.run(
    `INSERT INTO userPlans(id, userId, planId, source, creditTotalNanoUsd, creditRemainingNanoUsd, startsAt, expiresAt, status, createdAt)
     VALUES(?, ?, 'p1', ?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, source, USD(100), USD(100), at(ms), at(expiresMs), status, at(ms)]
  );
}

test("the timeline merges security, orders and plans newest first, only for the caller", () => {
  user("me");
  user("other");
  plan();
  activity("me", "login", T0);
  activity("me", "logout", T0 + 1 * HOUR);
  activity("me", "key_reveal", T0 + 2 * HOUR); // not a security event in the list
  order("o1", "me", T0 + 3 * HOUR);
  grant("up1", "me", T0 + 4 * HOUR);
  db.run(`INSERT INTO giftCodes(id, code, grantKind, creditNanoUsd, durationDays, maxRedemptions, redeemedCount, perUserLimit, isActive, createdAt, updatedAt)
          VALUES('g1', 'WELCOME~deleted~g1', 'credit', ?, 30, 5, 1, 1, 0, ?, ?)`, [USD(5), at(T0), at(T0)]);
  grant("up2", "me", T0 + 5 * HOUR, { source: "gift" });
  db.run(`INSERT INTO giftRedemptions(id, giftId, userId, userPlanId, redeemedAt) VALUES('r1', 'g1', 'me', 'up2', ?)`, [at(T0 + 5 * HOUR)]);
  activity("other", "login", T0 + 6 * HOUR);
  order("o2", "other", T0 + 6 * HOUR);

  const page = history.listAccountHistorySync(db, "me", { now: T0 + 10 * HOUR });
  assert.deepEqual(page.entries.map((e) => e.type), ["plan_granted", "plan_granted", "order", "logout", "login"]);
  assert.equal(page.entries[0].giftCode, "WELCOME", "a deleted code shows as typed");
  assert.equal(page.entries[0].source, "gift");
  assert.equal(page.entries[2].payAmount, 250000);
  assert.equal(page.entries[3].ip, "1.2.3.4");
  assert.equal(page.hasMore, false);
  assert.ok(page.entries.every((e) => !String(e.id).includes("o2")), "never another account's rows");
});

test("group filter, expiry entries and paging without gaps or duplicates", () => {
  user("me");
  plan();
  for (let i = 0; i < 7; i += 1) activity("me", "login", T0 + i * MIN);
  grant("old", "me", T0 - 40 * DAY, { expiresMs: T0 - 10 * DAY });
  grant("revoked", "me", T0 - 40 * DAY, { expiresMs: T0 - 10 * DAY, status: "revoked" });
  order("o1", "me", T0 + 10 * MIN, { status: "expired" });

  const plans = history.listAccountHistorySync(db, "me", { group: "plans", now: T0 });
  assert.deepEqual(plans.entries.map((e) => `${e.type}:${e.userPlanId}`).sort(), [
    "plan_expired:old", "plan_granted:old", "plan_granted:revoked",
  ], "a revoked plan has no expiry entry");

  const all = history.listAccountHistorySync(db, "me", { limit: 50, now: T0 + HOUR }).entries.map((e) => e.id);
  const paged = [];
  for (let offset = 0; offset < 20; offset += 3) {
    const page = history.listAccountHistorySync(db, "me", { offset, limit: 3, now: T0 + HOUR });
    paged.push(...page.entries.map((e) => e.id));
    if (!page.hasMore) break;
  }
  assert.deepEqual(paged, all);
  assert.equal(new Set(paged).size, paged.length);
  assert.deepEqual(history.listAccountHistorySync(db, "me", { group: "orders" }).entries.map((e) => e.status), ["expired"]);
});

test("summary counts paid orders per currency, credit spent and requests charged", () => {
  user("me");
  user("other");
  plan();
  order("o1", "me", T0, { amount: 250000 });
  order("o2", "me", T0 + MIN, { amount: 100000 });
  order("o3", "me", T0 + 2 * MIN, { currency: "USDT", amount: USD(10) });
  order("o4", "me", T0 + 3 * MIN, { status: "pending", amount: 999999 });
  order("o5", "other", T0, { amount: 777 });
  for (const [userId, delta, kind] of [["me", -USD(0.5), "charge"], ["me", -USD(0.25), "charge"], ["me", USD(100), "grant"], ["other", -USD(9), "charge"]]) {
    db.run(`INSERT INTO creditLedger(userId, deltaNanoUsd, kind, createdAt) VALUES(?, ?, ?, ?)`, [userId, delta, kind, at(T0)]);
  }
  assert.deepEqual(history.accountSummarySync(db, "me"), {
    createdAt: at(T0),
    lastLoginAt: at(T0 + DAY),
    paidOrders: 3,
    paidTotals: { VND: 350000, USDT: USD(10) },
    creditSpentNanoUsd: USD(0.75),
    requestsCharged: 2,
  });
});

test("paging stays exact when many entries share one timestamp", () => {
  user("me");
  plan();
  // A multi-period grant writes several rows with the same createdAt.
  for (const id of ["a", "b", "c", "d", "e", "f", "g"]) grant(`tie-${id}`, "me", T0);
  activity("me", "login", T0);
  activity("me", "logout", T0);
  order("o1", "me", T0);
  const all = history.listAccountHistorySync(db, "me", { limit: 50, now: T0 + MIN }).entries.map((e) => e.id);
  for (const size of [1, 2, 3, 4]) {
    const paged = [];
    for (let offset = 0; offset < 40; offset += size) {
      const page = history.listAccountHistorySync(db, "me", { offset, limit: size, now: T0 + MIN });
      paged.push(...page.entries.map((e) => e.id));
      if (!page.hasMore) break;
    }
    assert.deepEqual(paged, all, `page size ${size}`);
  }
});

test("confirming drops every other outstanding token of the account", () => {
  user("u1", { email: "old@test.local" });
  const now = at(T0);
  db.run(`INSERT INTO emailVerifications(id, userId, tokenHash, purpose, expiresAt, createdAt) VALUES('rp', 'u1', 'h-rp', 'reset_password', ?, ?)`, [at(T0 + HOUR), now]);
  db.run(`INSERT INTO emailVerifications(id, userId, tokenHash, purpose, expiresAt, createdAt) VALUES('ve', 'u1', 'h-ve', 'verify_email', ?, ?)`, [at(T0 + DAY), now]);
  const issued = change.createEmailChangeSync(db, "u1", "new@test.local", { now: T0 });
  db.transaction(() => change.confirmEmailChangeSync(db, issued.token, { now: T0 + MIN }));
  assert.deepEqual(
    db.all(`SELECT purpose FROM emailVerifications WHERE userId = 'u1' AND consumedAt IS NULL`),
    [],
    "a reset link in the old mailbox cannot take the account back"
  );
});
