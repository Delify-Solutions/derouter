// Billing-core tests against a real throwaway SQLite database.
//
// These pin the money invariants that are expensive to get wrong:
//   * FEFO: the plan expiring soonest is consumed first
//   * a plan is marked exhausted at exactly zero, and no plan goes negative
//   * a charge is idempotent per requestKey (retries cannot double-bill)
//   * a charge beyond all credit becomes overdraft, recorded in the ledger
//   * a grant pays the overdraft down before crediting a new plan
//   * expiry forfeits the remainder and is recorded, never silent
//
// The DB is created in a temp dir, so this test never touches real data.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// DATA_DIR must be set before the DB driver is imported, because paths.js
// resolves the database location at module load.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-billing-test-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const billing = await import("../src/lib/db/repos/billingRepo.js");
const { NANO } = await import("../src/shared/utils/money.js");

let db;
const USD = (n) => Math.round(n * NANO);

async function reset() {
  for (const t of [
    "creditLedger",
    "userPlans",
    "orders",
    "plans",
    "userSessions",
    "emailVerifications",
    "apiKeys",
    "users",
    "usageHistory",
    "requestDetails",
  ]) {
    try {
      db.run(`DELETE FROM ${t}`);
    } catch {
      /* table may not exist on a partial schema */
    }
  }
}

async function makeUser(email = "tenant@test.local") {
  return db.get(
    `SELECT * FROM users WHERE email = ?`,
    [email],
  );
}

function insertUser(id, email, overdraft = 0) {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, email, "x", "T", null, "active", overdraft, now, now],
  );
  return id;
}

function insertPlan(id, code, priceUsd, creditUsd, days) {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO plans(id, code, name, description, priceNanoUsd, creditNanoUsd, durationDays, isActive, sortOrder, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
    [id, code, code, null, USD(priceUsd), USD(creditUsd), days, now, now],
  );
  return id;
}

/** Create a userPlan directly with an explicit expiry offset (hours from now). */
async function grantWithExpiry({ userId, planId, creditUsd, expiresInHours, source = "purchase" }) {
  const id = `up_${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date();
  const startsAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + expiresInHours * 3600_000).toISOString();
  db.run(
    `INSERT INTO userPlans(id, userId, planId, orderId, source, creditTotalNanoUsd, creditRemainingNanoUsd, startsAt, expiresAt, status, createdAt)
     VALUES(?, ?, ?, NULL, ?, ?, ?, ?, ?, 'active', ?)`,
    [id, userId, planId, source, USD(creditUsd), USD(creditUsd), startsAt, expiresAt, startsAt],
  );
  return id;
}

before(async () => {
  db = await getAdapter();
  await reset();
});

after(() => {
  try {
    db?.close?.();
  } catch {
    /* adapters differ; the temp dir is removed regardless */
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("FEFO: the plan expiring soonest is consumed first", async () => {
  await reset();
  const u = insertUser("u-fefo", "fefo@test.local");
  insertPlan("p-fefo", "fefo", 1, 100, 30);

  const soon = await grantWithExpiry({ userId: u, planId: "p-fefo", creditUsd: 1, expiresInHours: 24 });
  const later = await grantWithExpiry({ userId: u, planId: "p-fefo", creditUsd: 2, expiresInHours: 240 });

  // Charge 1.5 USD: swallows the 1 USD plan, takes 0.5 from the later one.
  const res = db.transaction(() =>
    billing.chargeCreditsSync(db, {
      userId: u,
      apiKeyId: null,
      requestKey: "usage:1",
      costNanoUsd: USD(1.5),
    }),
  );

  const soonRow = db.get(`SELECT * FROM userPlans WHERE id = ?`, [soon]);
  const laterRow = db.get(`SELECT * FROM userPlans WHERE id = ?`, [later]);

  assert.equal(soonRow.creditRemainingNanoUsd, 0, "soonest plan must be drained to zero");
  assert.equal(soonRow.status, "exhausted", "soonest plan must be marked exhausted");
  // The later plan holds $2 and absorbs only the $0.5 the first could not cover.
  assert.equal(laterRow.creditRemainingNanoUsd, USD(1.5), "later plan absorbs the remainder");
  assert.equal(laterRow.status, "active", "later plan stays active");
  assert.equal(res.charged, USD(1.5));
  assert.equal(res.overdraftNanoUsd, 0);
});

test("a charge never drives a plan negative", async () => {
  await reset();
  const u = insertUser("u-neg", "neg@test.local");
  insertPlan("p-neg", "neg", 1, 10, 30);
  const p = await grantWithExpiry({ userId: u, planId: "p-neg", creditUsd: 1, expiresInHours: 24 });

  db.transaction(() =>
    billing.chargeCreditsSync(db, {
      userId: u,
      apiKeyId: null,
      requestKey: "usage:neg",
      costNanoUsd: USD(5),
    }),
  );

  const row = db.get(`SELECT * FROM userPlans WHERE id = ?`, [p]);
  assert.equal(row.creditRemainingNanoUsd, 0);
  assert.ok(row.creditRemainingNanoUsd >= 0, "remaining credit must never be negative");
});

test("a charge is idempotent per requestKey", async () => {
  await reset();
  const u = insertUser("u-idem", "idem@test.local");
  insertPlan("p-idem", "idem", 1, 10, 30);
  await grantWithExpiry({ userId: u, planId: "p-idem", creditUsd: 5, expiresInHours: 24 });

  const charge = (key) =>
    db.transaction(() =>
      billing.chargeCreditsSync(db, {
        userId: u,
        apiKeyId: null,
        requestKey: key,
        costNanoUsd: USD(1),
      }),
    );

  const first = charge("usage:42");
  const again = charge("usage:42");

  assert.equal(first.charged, USD(1));
  assert.equal(again.charged, 0, "replaying a requestKey must charge nothing");
  assert.equal(again.alreadyCharged, true);

  const ledger = db.all(
    `SELECT * FROM creditLedger WHERE userId = ? AND kind = 'charge'`,
    [u],
  );
  assert.equal(ledger.length, 1, "exactly one ledger row for one requestKey");

  const wallet = await billing.walletSummary(u);
  assert.equal(wallet.availableNanoUsd, USD(4), "only one of the two charges applied");
});

test("a charge beyond all credit becomes overdraft and is recorded", async () => {
  await reset();
  const u = insertUser("u-over", "over@test.local");
  insertPlan("p-over", "over", 1, 10, 30);
  await grantWithExpiry({ userId: u, planId: "p-over", creditUsd: 1, expiresInHours: 24 });

  db.transaction(() =>
    billing.chargeCreditsSync(db, {
      userId: u,
      apiKeyId: null,
      requestKey: "usage:over",
      costNanoUsd: USD(3),
    }),
  );

  const user = await makeUser("over@test.local");
  assert.equal(user.overdraftNanoUsd, USD(2), "the 2 USD beyond plan credit becomes debt");

  const wallet = await billing.walletSummary(u);
  assert.equal(wallet.availableNanoUsd, 0, "available credit must floor at zero");

  const overdraftRow = db.get(
    `SELECT * FROM creditLedger WHERE userId = ? AND userPlanId IS NULL AND kind = 'charge'`,
    [u],
  );
  assert.ok(overdraftRow, "the overdraft portion must have its own ledger row");
  assert.equal(overdraftRow.deltaNanoUsd, -USD(2));
});

test("a grant pays the overdraft down before crediting the new plan", async () => {
  await reset();
  const u = insertUser("u-pay", "pay@test.local", USD(2));
  insertPlan("p-pay", "pay", 10, 10, 30);

  const res = db.transaction(() =>
    billing.grantUserPlan(db, {
      userId: u,
      planId: "p-pay",
      orderId: null,
      source: "purchase",
      creditNanoUsd: USD(10),
      durationDays: 30,
    }),
  );

  assert.equal(res.appliedToOverdraftNanoUsd, USD(2), "debt is settled first");

  const user = await makeUser("pay@test.local");
  assert.equal(user.overdraftNanoUsd, 0, "overdraft cleared");

  const plan = db.get(`SELECT * FROM userPlans WHERE id = ?`, [res.userPlan.id]);
  assert.equal(plan.creditRemainingNanoUsd, USD(8), "only the remainder lands on the plan");

  const wallet = await billing.walletSummary(u);
  assert.equal(wallet.availableNanoUsd, USD(8));
});

test("expired plans cannot be spent and are forfeited with a ledger row", async () => {
  await reset();
  const u = insertUser("u-exp", "exp@test.local");
  insertPlan("p-exp", "exp", 1, 10, 30);
  const expired = await grantWithExpiry({
    userId: u,
    planId: "p-exp",
    creditUsd: 4,
    expiresInHours: -1, // already past
  });

  // Past-expiry credit must not count as available.
  const wallet = await billing.walletSummary(u);
  assert.equal(wallet.availableNanoUsd, 0, "expired credit is not spendable");

  const sweep = db.transaction(() => billing.expireStalePlans(db));
  assert.ok(sweep.expired >= 1, "the sweep must find the expired plan");
  assert.equal(sweep.forfeitedNanoUsd, USD(4), "the whole remainder is forfeited");

  const row = db.get(`SELECT * FROM userPlans WHERE id = ?`, [expired]);
  assert.equal(row.status, "expired");
  assert.equal(row.creditRemainingNanoUsd, 0);

  const expiryLedger = db.get(
    `SELECT * FROM creditLedger WHERE userId = ? AND kind = 'expire'`,
    [u],
  );
  assert.ok(expiryLedger, "forfeiture must be recorded, not silent");
  assert.equal(expiryLedger.deltaNanoUsd, -USD(4));

  // Second sweep is a no-op.
  const again = db.transaction(() => billing.expireStalePlans(db));
  assert.equal(again.expired, 0);
});

test("refunding an order takes its unspent credit back and grants nothing", async () => {
  await reset();
  const u = insertUser("u-ref", "ref@test.local");
  insertPlan("p-ref", "ref", 10, 25, 30);
  const order = await billing.createOrder({ userId: u, planId: "p-ref", method: "manual" });
  await billing.approveOrder(order.id, "admin");

  // Spend $5 so the refund has both a spent and an unspent part.
  db.run(`UPDATE userPlans SET creditRemainingNanoUsd = ? WHERE userId = ?`, [USD(20), u]);
  assert.equal((await billing.walletSummary(u)).availableNanoUsd, USD(20));

  const result = await billing.refundOrder(order.id, { adminId: "a1", adminNote: "customer asked" });

  assert.equal(result.alreadyRefunded, false);
  assert.equal(result.userPlan, null, "a refund must not create a new plan");
  assert.equal(result.refundedNanoUsd, USD(20), "only the unspent credit is taken back");
  assert.equal((await billing.walletSummary(u)).availableNanoUsd, 0);

  const plans = db.all(`SELECT * FROM userPlans WHERE userId = ?`, [u]);
  assert.equal(plans.length, 1, "no compensation plan");
  assert.equal(plans[0].status, "refunded");
  assert.equal(plans[0].creditRemainingNanoUsd, 0);

  const revoke = db.get(`SELECT * FROM creditLedger WHERE userId = ? AND kind = 'revoke'`, [u]);
  assert.equal(revoke.deltaNanoUsd, -USD(20));

  const again = await billing.refundOrder(order.id, { adminId: "a1" });
  assert.equal(again.alreadyRefunded, true);
  assert.equal(db.all(`SELECT * FROM creditLedger WHERE userId = ? AND kind = 'revoke'`, [u]).length, 1);
});

test("approving an order twice grants exactly once", async () => {
  await reset();
  const u = insertUser("u-ord", "ord@test.local");
  insertPlan("p-ord", "ord", 10, 25, 30);

  const order = await billing.createOrder({
    userId: u,
    planId: "p-ord",
    method: "manual",
  });

  // approveOrder opens its own transaction, so it must not be wrapped again.
  const first = await billing.approveOrder(order.id, "admin");
  const second = await billing.approveOrder(order.id, "admin");

  assert.equal(second.alreadyApproved, true, "a second approval must be a no-op");

  const grants = db.all(`SELECT * FROM userPlans WHERE userId = ?`, [u]);
  assert.equal(grants.length, 1, "exactly one grant for one order");

  const wallet = await billing.walletSummary(u);
  assert.equal(wallet.availableNanoUsd, USD(25));

  // The order snapshotted its amounts at creation time.
  const row = db.get(`SELECT * FROM orders WHERE id = ?`, [order.id]);
  assert.equal(row.amountNanoUsd, USD(10));
  assert.equal(row.creditNanoUsd, USD(25));
  assert.equal(row.status, "paid");
});

test("an order snapshot survives a later plan price change", async () => {
  await reset();
  const u = insertUser("u-snap", "snap@test.local");
  insertPlan("p-snap", "snap", 10, 25, 30);
  const order = await billing.createOrder({ userId: u, planId: "p-snap", method: "manual" });

  // Admin raises the price after the order was placed.
  await billing.updatePlan("p-snap", { priceNanoUsd: USD(99), creditNanoUsd: USD(99) });

  await billing.approveOrder(order.id, "admin");

  const wallet = await billing.walletSummary(u);
  assert.equal(wallet.availableNanoUsd, USD(25), "the grant uses the snapshot, not the new price");
});

test("a zero-cost charge writes no ledger row", async () => {
  await reset();
  const u = insertUser("u-free", "free@test.local");
  insertPlan("p-free", "free", 1, 10, 30);
  await grantWithExpiry({ userId: u, planId: "p-free", creditUsd: 5, expiresInHours: 24 });

  db.transaction(() =>
    billing.chargeCreditsSync(db, {
      userId: u,
      apiKeyId: null,
      requestKey: "usage:free",
      costNanoUsd: 0,
    }),
  );

  const rows = db.all(`SELECT * FROM creditLedger WHERE userId = ? AND kind = 'charge'`, [u]);
  assert.equal(rows.length, 0, "a free request must not pollute the ledger");
});

test("walletSummary reports the granted total and per-plan remaining", async () => {
  await reset();
  const u = insertUser("u-sum", "sum@test.local");
  insertPlan("p-sum", "sum", 10, 25, 30);
  await grantWithExpiry({ userId: u, planId: "p-sum", creditUsd: 10, expiresInHours: 48 });
  await grantWithExpiry({ userId: u, planId: "p-sum", creditUsd: 5, expiresInHours: 240 });

  const wallet = await billing.walletSummary(u);
  assert.equal(wallet.availableNanoUsd, USD(15));
  assert.equal(wallet.totalGrantedNanoUsd, USD(15));
  assert.equal(wallet.overdraftNanoUsd, 0);
  assert.equal(wallet.plans.length, 2);
  for (const p of wallet.plans) {
    assert.ok(Number.isInteger(p.creditRemainingNanoUsd), "wallet figures must be integers");
  }
});
