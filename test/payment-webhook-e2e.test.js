// End-to-end: the SePay webhook → approval path, exercised through the real route
// handler (spec payment-reconciliation "SePay webhook", task 7.2/10.2).
//
// This is the same request SePay sends: a curl POST with an `Authorization: Apikey`
// header and the documented JSON body. It asserts the four answers the route
// promises (401 / 400 / 413 / 200), and that a replay changes nothing.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-webhook-e2e-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const { handleSepayWebhook } = await import("../src/lib/payments/webhook.js");
const { NANO } = await import("../src/shared/utils/money.js");

let db;
const USD = (n) => Math.round(n * NANO);
const NOW = new Date();

before(async () => { db = await getAdapter(); });

after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function seed({ code = "DR8K3Q7MZP", payAmount = 250000, expiresInMs = 30 * 60 * 1000 } = {}) {
  for (const table of ["paymentTransactions", "paymentProviders", "userPlanWindows", "creditLedger", "userPlans", "orders", "plans", "users"]) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* partial schema */ }
  }
  const now = NOW.toISOString();
  db.run(
    `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
     VALUES('u1', 'buyer@test.local', 'x', NULL, NULL, 'active', 0, ?, ?)`,
    [now, now]
  );
  db.run(
    `INSERT INTO plans(id, code, name, priceNanoUsd, priceVnd, creditNanoUsd, durationDays, isActive, createdAt, updatedAt)
     VALUES('p1', 'go', 'Go', ?, 250000, ?, 30, 1, ?, ?)`,
    [USD(10), USD(250), now, now]
  );

  // The provider row is seeded directly: `paymentProvidersRepo` is the only module
  // here that needs `secrets.js`, and that one is covered by the payment tests that
  // run under the Next.js alias. `decryptSecret` passes a plaintext value through,
  // so the route reads this key exactly as it reads a real encrypted one.
  const providerId = "prov-sepay-1";
  const webhookKey = "e2e-webhook-key-9f0c1d2e3b4a5c6d7e8f";
  db.run(
    `INSERT INTO paymentProviders(id, kind, name, isActive, sortOrder, config, secrets, pollIntervalSeconds, createdAt, updatedAt)
     VALUES(?, 'sepay', 'Vietcombank - nhận tiền', 1, 0, ?, ?, 30, ?, ?)`,
    [
      providerId,
      JSON.stringify({
        bankBin: "970436",
        bankName: "Vietcombank",
        accountNumber: "1017588888",
        accountName: "NGUYEN VAN A",
      }),
      JSON.stringify({ webhookKey }),
      now,
      now,
    ]
  );

  db.run(
    `INSERT INTO orders(
       id, userId, planId, amountNanoUsd, creditNanoUsd, durationDays, status, method,
       paymentCode, payCurrency, payAmount, paymentProviderId, expiresAt, createdAt
     ) VALUES('o1', 'u1', 'p1', ?, ?, 30, 'pending', 'vietqr', ?, 'VND', ?, ?, ?, ?)`,
    [USD(10), USD(250), code, payAmount, providerId, new Date(Date.now() + expiresInMs).toISOString(), now]
  );

  return { webhookKey, providerId };
}

function payload(overrides = {}) {
  const pad = (n) => String(n).padStart(2, "0");
  const d = new Date();
  return {
    id: 92704,
    gateway: "Vietcombank",
    transactionDate: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours() + 7)}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
    accountNumber: "1017588888",
    subAccount: "",
    code: null,
    content: "MBVCB.1234567.DR8K3Q7MZP.CT tu 0123 toi 9876",
    transferType: "in",
    description: "NGUYEN VAN A chuyen tien",
    transferAmount: 250000,
    accumulated: 105000000,
    referenceCode: "FT24012345678",
    ...overrides,
  };
}

function request(body, authorization, { raw = false } = {}) {
  const headers = { "content-type": "application/json" };
  if (authorization) headers.authorization = authorization;
  return new Request("http://localhost/api/payments/sepay/webhook", {
    method: "POST",
    headers,
    body: raw ? body : JSON.stringify(body),
  });
}

/** Run one delivery through the handler with the provider rows the route would load. */
async function deliver(body, authorization, { raw = false } = {}) {
  const providers = db
    .all(`SELECT * FROM paymentProviders WHERE kind = 'sepay' AND isActive = 1`)
    .map((row) => ({
      ...row,
      config: JSON.parse(row.config || "{}"),
      secrets: JSON.parse(row.secrets || "{}"),
    }));
  return handleSepayWebhook(request(body, authorization, { raw }), {
    providers,
    db,
    settings: { paymentCodePrefix: "DR" },
    // Notifications are out of scope for this test; the handler ignores a missing
    // notifier.
  });
}

const order = () => db.get(`SELECT * FROM orders WHERE id = 'o1'`);
const txCount = () => Number(db.get(`SELECT COUNT(*) AS n FROM paymentTransactions`)?.n ?? 0);
const planCount = () => Number(db.get(`SELECT COUNT(*) AS n FROM userPlans`)?.n ?? 0);

test("a POST with the right key approves the order and queues the plan", async () => {
  const { webhookKey } = await seed();

  const res = await deliver(payload(), `Apikey ${webhookKey}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { success: true });

  const row = order();
  assert.equal(row.status, "paid");
  assert.equal(row.approvedBy, "payment:sepay");
  assert.ok(row.paymentTransactionId, "the approving transaction is linked");
  assert.equal(planCount(), 1);
});

test("a wrong key gets 401 and stores nothing", async () => {
  const { webhookKey } = await seed();

  const res = await deliver(payload(), "Apikey not-the-key");
  assert.equal(res.status, 401);
  assert.equal(txCount(), 0);
  assert.equal(order().status, "pending");

  // A key of a different length must not throw either.
  const short = await deliver(payload(), "Apikey x");
  assert.equal(short.status, 401);
  assert.equal(txCount(), 0);
  assert.ok(webhookKey);
});

test("a missing Authorization header gets 401", async () => {
  await seed();
  const res = await deliver(payload(), null);
  assert.equal(res.status, 401);
});

test("a replay of the same transaction changes nothing", async () => {
  const { webhookKey } = await seed();

  await deliver(payload(), `Apikey ${webhookKey}`);
  const afterFirst = { status: order().status, plans: planCount(), txs: txCount() };

  const res = await deliver(payload(), `Apikey ${webhookKey}`);
  assert.equal(res.status, 200, "SePay must not retry");
  assert.deepEqual(res.body, { success: true });

  assert.equal(order().status, afterFirst.status);
  assert.equal(planCount(), afterFirst.plans, "no second grant");
  assert.equal(txCount(), afterFirst.txs, "one row");
});

test("bad JSON gets 400 with the right key", async () => {
  const { webhookKey } = await seed();
  const res = await deliver("{not json", `Apikey ${webhookKey}`, { raw: true });
  assert.equal(res.status, 400);
  assert.equal(txCount(), 0);
});

test("a body over 64 KB gets 413", async () => {
  const { webhookKey } = await seed();
  const big = JSON.stringify(payload({ pad: "x".repeat(70 * 1024) }));
  const res = await deliver(big, `Apikey ${webhookKey}`, { raw: true });
  assert.equal(res.status, 413);
  assert.equal(txCount(), 0);
});

test("a wrong amount is stored for review, and the route still answers 200", async () => {
  const { webhookKey } = await seed();

  const res = await deliver(payload({ transferAmount: 200000 }), `Apikey ${webhookKey}`);
  assert.equal(res.status, 200);

  assert.equal(order().status, "pending", "the order must not be approved");
  const row = db.get(`SELECT * FROM paymentTransactions`);
  assert.equal(row.status, "needs_review");
  assert.equal(row.reason, "amount_mismatch");
});

test("a transfer to another account is kept as wrong_provider", async () => {
  const { webhookKey } = await seed();

  const res = await deliver(payload({ accountNumber: "9999999999" }), `Apikey ${webhookKey}`);
  assert.equal(res.status, 200);
  assert.equal(order().status, "pending");
  const row = db.get(`SELECT * FROM paymentTransactions`);
  assert.equal(row.status, "needs_review");
  assert.equal(row.reason, "wrong_provider", "the money arrived somewhere this order cannot be paid to");
});

test("a payment after expiry is reviewed, not approved", async () => {
  const { webhookKey } = await seed({ expiresInMs: -60 * 1000 });

  const res = await deliver(payload(), `Apikey ${webhookKey}`);
  assert.equal(res.status, 200);
  assert.equal(order().status, "pending", "the route never approves a stale order");
  assert.equal(db.get(`SELECT reason FROM paymentTransactions`).reason, "order_expired");
});

test("an outgoing transaction is accepted and ignored", async () => {
  const { webhookKey } = await seed();

  const res = await deliver(
    payload({ id: 999, transferType: "out", content: "chuyen tien di" }),
    `Apikey ${webhookKey}`
  );
  assert.equal(res.status, 200);
  assert.equal(txCount(), 0, "outgoing money is not a payment");
});

test("an inactive provider's key is refused", async () => {
  const { webhookKey, providerId } = await seed();
  db.run(`UPDATE paymentProviders SET isActive = 0 WHERE id = ?`, [providerId]);

  const res = await deliver(payload(), `Apikey ${webhookKey}`);
  assert.equal(res.status, 401);
  assert.equal(txCount(), 0);
});

test("no error body ever echoes the webhook key", async () => {
  const { webhookKey } = await seed();
  const responses = [
    await deliver(payload(), "Apikey wrong"),
    await deliver("{bad", `Apikey ${webhookKey}`, { raw: true }),
    await deliver(payload({ id: 1, content: "no code here" }), `Apikey ${webhookKey}`),
  ];
  for (const res of responses) {
    const text = JSON.stringify(res.body);
    assert.equal(text.includes(webhookKey), false, `leaked the key in "${text}"`);
  }
});
