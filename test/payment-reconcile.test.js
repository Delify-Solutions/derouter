// Reconciliation engine (design D4, specs/payment-reconciliation, task 6.2).
//
// These are the money-safety tests: one row per transaction, one approval per
// order, and every "cannot match" case landing in needs_review with the right
// reason instead of silently crediting or silently dropping.
//
// Throwaway SQLite DB; every function under test is synchronous and takes the
// adapter, so `now` is always explicit — no sleeping, no clock mocking.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-payment-reconcile-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const reconcile = await import("../src/lib/payments/reconcile.js");
const { approveOrderSync } = await import("../src/lib/billing/orders.js");
const { NANO } = await import("../src/shared/utils/money.js");

let db;
const USD = (n) => Math.round(n * NANO);

const T0 = Date.UTC(2026, 9, 29, 10, 0, 0);
const at = (ms) => new Date(ms).toISOString();
const MIN = 60 * 1000;

const SETTINGS = { paymentCodePrefix: "DR" };

before(async () => { db = await getAdapter(); });

after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  for (const table of [
    "paymentTransactions",
    "paymentProviders",
    "userPlanWindows",
    "creditLedger",
    "userPlans",
    "orders",
    "plans",
    "apiKeys",
    "users",
    "kv",
    "userAuditLog",
  ]) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* partial schema */ }
  }
});

// ── Fixtures ────────────────────────────────────────────────────────────────

function user(id = "u1") {
  db.run(
    `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
     VALUES(?, ?, 'x', NULL, NULL, 'active', 0, ?, ?)`,
    [id, `${id}@test.local`, at(T0), at(T0)]
  );
  return id;
}

function plan(id = "p1", { priceUsd = 10, priceVnd = 250000, creditUsd = 250, days = 30 } = {}) {
  db.run(
    `INSERT INTO plans(id, code, name, priceNanoUsd, priceVnd, creditNanoUsd, durationDays, isActive, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [id, id, id.toUpperCase(), USD(priceUsd), priceVnd, USD(creditUsd), days, at(T0), at(T0)]
  );
  return id;
}

function provider(id = "prov1", kind = "sepay") {
  db.run(
    `INSERT OR REPLACE INTO paymentProviders(id, kind, name, isActive, sortOrder, config, secrets, pollIntervalSeconds, createdAt, updatedAt)
     VALUES(?, ?, ?, 1, 0, ?, '{}', 30, ?, ?)`,
    [id, kind, `Provider ${id}`, JSON.stringify({ accountNumber: "1017588888", bankBin: "970436", bankName: "Vietcombank" }), at(T0), at(T0)]
  );
  return { id, kind, name: `Provider ${id}`, config: { accountNumber: "1017588888" } };
}

function order({
  id = "o1",
  code = "DR8K3Q7MZP",
  providerId = "prov1",
  status = "pending",
  payCurrency = "VND",
  payAmount = 250000,
  createdAt = T0,
  expiresAt = T0 + 30 * MIN,
  planId = "p1",
  userId = "u1",
} = {}) {
  db.run(
    `INSERT INTO orders(
       id, userId, planId, amountNanoUsd, creditNanoUsd, durationDays, status, method,
       paymentCode, payCurrency, payAmount, paymentProviderId, expiresAt, createdAt
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, userId, planId, USD(10), USD(250), 30, status,
      payCurrency === "USDT" ? "binance" : "vietqr",
      code, payCurrency, payAmount, providerId, at(expiresAt), at(createdAt),
    ]
  );
  return id;
}

function tx(overrides = {}) {
  return {
    externalId: "ext-1",
    direction: "in",
    amount: 250000,
    currency: "VND",
    content: "MBVCB.DR8K3Q7MZP.CT tu 0123",
    occurredAt: at(T0 + 5 * MIN),
    raw: { id: "ext-1" },
    ...overrides,
  };
}

function ingest(providerRow, overrides = {}, options = {}) {
  return db.transaction(() => reconcile.ingestTransactionSync(db, {
    provider: providerRow,
    tx: tx(overrides),
    via: "webhook",
    nowIso: at(T0 + 10 * MIN),
    settings: SETTINGS,
    ...options,
  }));
}

function orderRow(id = "o1") {
  return db.get(`SELECT * FROM orders WHERE id = ?`, [id]);
}

function txRows() {
  return db.all(`SELECT * FROM paymentTransactions ORDER BY receivedAt ASC`);
}

function userPlanCount() {
  return Number(db.get(`SELECT COUNT(*) AS n FROM userPlans`)?.n ?? 0);
}

// ── The good path ──────────────────────────────────────────────────────────

test("an exact VND payment approves the order and queues the plan", () => {
  user(); plan(); const p = provider(); order();

  const result = ingest(p);

  assert.equal(result.outcome, "matched");
  assert.equal(result.orderId, "o1");
  const o = orderRow();
  assert.equal(o.status, "paid");
  assert.equal(o.approvedBy, "payment:sepay");
  assert.equal(o.paymentTransactionId, result.transactionId);
  assert.equal(userPlanCount(), 1, "the plan must be in the queue");

  const stored = txRows();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, "matched");
  assert.equal(stored[0].orderId, "o1");
});

test("a duplicate delivery changes nothing", () => {
  user(); plan(); const p = provider(); order();

  const first = ingest(p);
  const balanceAfterFirst = db.get(`SELECT creditRemainingNanoUsd FROM userPlans`).creditRemainingNanoUsd;
  const second = ingest(p);

  assert.equal(first.outcome, "matched");
  assert.equal(second.outcome, "duplicate");
  assert.equal(txRows().length, 1, "one row per (provider, externalId)");
  assert.equal(userPlanCount(), 1, "no second grant");
  assert.equal(
    db.get(`SELECT creditRemainingNanoUsd FROM userPlans`).creditRemainingNanoUsd,
    balanceAfterFirst
  );
});

test("the same external id from a different provider is a different transaction", () => {
  user(); plan();
  const sepay = provider("prov1", "sepay");
  const web2m = provider("prov2", "web2m");
  order({ id: "o1", code: "DR8K3Q7MZP", providerId: "prov1" });
  order({ id: "o2", code: "DRAAAA2222", providerId: "prov2" });

  ingest(sepay, { externalId: "same-id", content: "DR8K3Q7MZP" });
  const result = ingest(web2m, { externalId: "same-id", content: "DRAAAA2222" });

  assert.equal(result.outcome, "matched");
  assert.equal(txRows().length, 2);
});

test("an outgoing transaction is ignored and not stored", () => {
  user(); plan(); const p = provider(); order();

  const result = ingest(p, { direction: "out" });

  assert.equal(result.outcome, "ignored");
  assert.equal(txRows().length, 0);
  assert.equal(orderRow().status, "pending");
});

test("a USDT overpayment approves", () => {
  user(); plan();
  const p = provider("provb", "binance");
  order({ payCurrency: "USDT", payAmount: 10_000_000_000, providerId: "provb" });

  const result = ingest(p, { amount: 10_500_000_000, currency: "USDT" });

  assert.equal(result.outcome, "matched");
  assert.equal(orderRow().status, "paid");
});

// ── Review reasons ─────────────────────────────────────────────────────────

const reviewCases = [
  {
    label: "no code in the memo",
    setup: () => { user(); plan(); provider(); order(); },
    tx: { content: "thanh toan tien hang" },
    reason: "no_code",
  },
  {
    label: "a code that belongs to no order",
    setup: () => { user(); plan(); provider(); },
    tx: { content: "DRZZZZ9999 chuyen tien" },
    reason: "order_not_found",
  },
  {
    label: "the order uses another provider",
    setup: () => {
      user(); plan();
      provider("prov1", "sepay");
      provider("prov2", "web2m");
      order({ providerId: "prov2" });
    },
    // The ingesting provider here is prov1, the order names prov2.
    usesProvider: "prov1",
    tx: { content: "DR8K3Q7MZP" },
    reason: "wrong_provider",
  },
  {
    label: "the order is already paid",
    setup: () => { user(); plan(); provider(); order({ status: "paid" }); },
    tx: { content: "DR8K3Q7MZP" },
    reason: "order_not_pending",
  },
  {
    label: "the order was cancelled",
    setup: () => { user(); plan(); provider(); order({ status: "cancelled" }); },
    tx: { content: "DR8K3Q7MZP" },
    reason: "order_not_pending",
  },
  {
    label: "the order expired before the payment",
    setup: () => { user(); plan(); provider(); order({ status: "expired" }); },
    tx: { content: "DR8K3Q7MZP" },
    reason: "order_expired",
  },
  {
    label: "a still-pending order paid after its expiry",
    setup: () => { user(); plan(); provider(); order(); },
    tx: { content: "DR8K3Q7MZP", occurredAt: at(T0 + 31 * MIN) },
    reason: "order_expired",
  },
  {
    label: "the wrong amount",
    setup: () => { user(); plan(); provider(); order(); },
    tx: { amount: 200000, content: "DR8K3Q7MZP" },
    reason: "amount_mismatch",
  },
  {
    label: "a payment made before the order existed",
    setup: () => { user(); plan(); provider(); order(); },
    tx: { content: "DR8K3Q7MZP", occurredAt: at(T0 - 10 * MIN) },
    reason: "order_not_found",
  },
];

for (const testCase of reviewCases) {
  test(`review reason: ${testCase.label} → ${testCase.reason}`, () => {
    testCase.setup();
    const providerRow = provider(testCase.usesProvider ?? "prov1", "sepay");

    const result = ingest(providerRow, testCase.tx);

    assert.equal(result.outcome, "needs_review");
    assert.equal(result.reason, testCase.reason);

    const current = orderRow();
    if (current) {
      // The setup may already have left the order paid/cancelled/expired; what
      // matters is that ingesting did not move it to a fresh approval.
      const untouched = testCase.reason === "order_not_pending" || testCase.reason === "order_expired";
      assert.equal(
        current.paymentTransactionId,
        null,
        untouched ? "a review row must not be linked as the approving payment" : "still unapproved"
      );
    }
    assert.equal(userPlanCount(), 0, "no credit may be granted by a review");
    const stored = txRows();
    assert.equal(stored.length, 1, "the money is still recorded");
    assert.equal(stored[0].status, "needs_review");
    assert.equal(stored[0].reason, testCase.reason);
  });
}

test("USDT underpayment is underpaid, exact is matched", () => {
  user(); plan();
  const p = provider("provb", "binance");
  order({ id: "o1", payCurrency: "USDT", payAmount: 10_000_000_000, providerId: "provb" });

  const short = ingest(p, { externalId: "e1", amount: 9_999_999_999, currency: "USDT" });
  assert.equal(short.reason, "underpaid");
  assert.equal(orderRow("o1").status, "pending");

  const exact = ingest(p, { externalId: "e2", amount: 10_000_000_000, currency: "USDT" });
  assert.equal(exact.outcome, "matched");
  assert.equal(orderRow("o1").status, "paid");
});

test("a currency mismatch with the order is a wrong_provider review", () => {
  user(); plan();
  const p = provider("provb", "binance");
  order({ payCurrency: "VND", payAmount: 250000, providerId: "provb" });

  const result = ingest(p, { amount: 10_000_000_000, currency: "USDT" });

  assert.equal(result.reason, "wrong_provider");
});

// ── Dry run ────────────────────────────────────────────────────────────────

test("a dry run reports the decision and writes nothing", () => {
  user(); plan(); const p = provider(); order();

  const result = ingest(p, {}, { dryRun: true });

  assert.equal(result.outcome, "matched");
  assert.equal(result.orderId, "o1");
  assert.equal(result.dryRun, true);
  assert.equal(txRows().length, 0, "nothing stored");
  assert.equal(orderRow().status, "pending", "nothing approved");
  assert.equal(userPlanCount(), 0);
});

test("a dry run reports a duplicate without touching the row", () => {
  user(); plan(); const p = provider(); order();
  ingest(p);

  const result = ingest(p, {}, { dryRun: true });

  assert.equal(result.outcome, "duplicate");
  assert.equal(txRows().length, 1);
});

test("a dry run reports the same review reason a real ingest would", () => {
  user(); plan(); const p = provider(); order();

  const dry = ingest(p, { amount: 1000 }, { dryRun: true });
  const real = ingest(p, { amount: 1000 });

  assert.equal(dry.reason, real.reason);
  assert.equal(dry.outcome, real.outcome);
});

// ── Approval idempotency ───────────────────────────────────────────────────

test("approveOrderSync refuses a paid order and grants nothing", () => {
  user(); plan(); provider();
  order();
  const first = db.transaction(() => approveOrderSync(db, "o1", { approvedBy: "admin:test", now: at(T0 + MIN) }));
  const second = db.transaction(() => approveOrderSync(db, "o1", { approvedBy: "admin:test2", now: at(T0 + 2 * MIN) }));

  assert.equal(first.alreadyApproved, false);
  assert.equal(second.alreadyApproved, true);
  assert.equal(userPlanCount(), 1);
});

test("a second payment for an already-paid order cannot grant a second plan", () => {
  user(); plan(); const p = provider(); order();
  ingest(p, { externalId: "e1" });
  // A different transfer (different external id) with the same code.
  const second = ingest(p, { externalId: "e2" });

  assert.equal(second.outcome, "needs_review");
  assert.equal(second.reason, "order_not_pending");
  assert.equal(userPlanCount(), 1, "still exactly one grant");
});

// ── Admin resolution ───────────────────────────────────────────────────────

test("assign approves an expired order once, and a second assign is refused", () => {
  user(); plan(); const p = provider();
  order({ status: "expired" });
  const late = ingest(p, { externalId: "late-1", occurredAt: at(T0 + 40 * MIN) });
  assert.equal(late.reason, "order_expired");

  const assigned = db.transaction(() => reconcile.resolveTransactionSync(db, {
    transactionId: late.transactionId,
    action: "assign",
    orderId: "o1",
    reason: "Khách chuyển muộn 3 phút",
    actor: "admin:ops",
    nowIso: at(T0 + 50 * MIN),
  }));

  assert.equal(assigned.ok, true);
  assert.equal(orderRow().status, "paid");
  assert.equal(userPlanCount(), 1);
  assert.equal(assigned.transaction.status, "matched");
  assert.equal(assigned.transaction.resolvedBy, "admin:ops");
  assert.equal(assigned.transaction.resolutionNote, "Khách chuyển muộn 3 phút");

  // A second assign on the same transaction is refused: it is no longer needs_review.
  const again = db.transaction(() => reconcile.resolveTransactionSync(db, {
    transactionId: late.transactionId,
    action: "assign",
    orderId: "o1",
    reason: "Lần hai",
    actor: "admin:ops",
  }));
  assert.equal(again.ok, false);
  assert.equal(again.code, "already");
  assert.equal(userPlanCount(), 1);
});

test("assign refuses an order that is already paid", () => {
  user(); plan(); provider();
  order({ id: "o1", status: "paid" });
  order({ id: "o2", code: "DRAAAA2222" });
  const review = ingest(provider(), { externalId: "r1", content: "DRAAAA2222", amount: 1 });

  const result = db.transaction(() => reconcile.resolveTransactionSync(db, {
    transactionId: review.transactionId,
    action: "assign",
    orderId: "o1",
    reason: "Gán nhầm đơn đã trả",
    actor: "admin:ops",
  }));

  assert.equal(result.ok, false);
  assert.equal(result.code, "order_not_resolvable");
});

test("resolve requires a reason and refuses a matched row", () => {
  user(); plan(); const p = provider(); order();
  const review = ingest(p, { externalId: "r1", amount: 1000 });

  const noReason = db.transaction(() => reconcile.resolveTransactionSync(db, {
    transactionId: review.transactionId,
    action: "resolve",
    reason: "  ",
    actor: "admin:ops",
  }));
  assert.equal(noReason.ok, false);
  assert.equal(noReason.code, "invalid");

  const ok = db.transaction(() => reconcile.resolveTransactionSync(db, {
    transactionId: review.transactionId,
    action: "resolve",
    reason: "Đã hoàn tiền ngoài hệ thống",
    actor: "admin:ops",
  }));
  assert.equal(ok.ok, true);
  assert.equal(ok.transaction.status, "resolved");

  const again = db.transaction(() => reconcile.resolveTransactionSync(db, {
    transactionId: review.transactionId,
    action: "resolve",
    reason: "Lần hai",
    actor: "admin:ops",
  }));
  assert.equal(again.ok, false);
  assert.equal(again.code, "already");
});

test("resolve writes an audit entry on the order owner when an order is involved", () => {
  user(); plan(); const p = provider(); order();
  const review = ingest(p, { externalId: "r1", amount: 1000 });

  db.transaction(() => reconcile.resolveTransactionSync(db, {
    transactionId: review.transactionId,
    action: "resolve",
    reason: "Sai số tiền, khách đồng ý huỷ",
    actor: "admin:ops",
  }));

  const rows = db.all(`SELECT * FROM userAuditLog WHERE action = 'payment_resolved'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].userId, "u1");
  assert.equal(rows[0].actor, "admin:ops");
});

test("assign writes a payment_assigned audit entry with the previous reason", () => {
  user(); plan(); const p = provider(); order({ status: "expired" });
  const late = ingest(p, { externalId: "late", occurredAt: at(T0 + 40 * MIN) });

  db.transaction(() => reconcile.resolveTransactionSync(db, {
    transactionId: late.transactionId,
    action: "assign",
    orderId: "o1",
    reason: "Khách chuyển muộn",
    actor: "admin:ops",
  }));

  const rows = db.all(`SELECT * FROM userAuditLog WHERE action = 'payment_assigned'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].userId, "u1");
  assert.match(rows[0].details, /order_expired/);
});

test("a resolved transaction is not counted as needs_review any more", () => {
  user(); plan(); const p = provider(); order();
  const review = ingest(p, { externalId: "r1", amount: 1000 });
  assert.equal(reconcile.readTransaction(db, review.transactionId).status, "needs_review");
  db.transaction(() => reconcile.resolveTransactionSync(db, {
    transactionId: review.transactionId,
    action: "resolve",
    reason: "Đã xử lý tay",
    actor: "admin:ops",
  }));
  assert.equal(reconcile.readTransaction(db, review.transactionId).status, "resolved");
});

// ── Review reason vocabulary ───────────────────────────────────────────────

test("every review reason the engine can produce is in the published list", () => {
  const expected = [
    "no_code", "order_not_found", "wrong_provider", "order_not_pending",
    "order_expired", "amount_mismatch", "underpaid",
  ];
  for (const reason of expected) {
    assert.equal(reconcile.REVIEW_REASONS.includes(reason), true, `${reason} missing`);
  }
});

test("isValidReason enforces 3–500 characters", () => {
  assert.equal(reconcile.isValidReason("ab"), false);
  assert.equal(reconcile.isValidReason("abc"), true);
  assert.equal(reconcile.isValidReason("x".repeat(500)), true);
  assert.equal(reconcile.isValidReason("x".repeat(501)), false);
});
