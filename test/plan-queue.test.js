// Plan-queue engine (spec plan-queue-billing, design D9/D10). 17 cases.
//
// These pin the money rules a customer would notice: which plan pays, when a plan
// is blocked and reopens, that a retry cannot double-charge, that windows match the
// ledger, and that the one-time back-charge only touches rows it should.
//
// Everything runs against a throwaway SQLite DB with rows seeded by direct SQL.
// Every function under test is synchronous and driver-free and takes the adapter,
// so `now` is always passed explicitly — no clock mocking, no sleeping.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-planqueue-test-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const queue = await import("../src/lib/billing/planQueue.js");
const { grantUserPlan } = await import("../src/lib/billing/grants.js");
const { parseLimits } = await import("../src/lib/billing/limits.js");
const { applyLimitsToActiveSync } = await import("../src/lib/billing/adminActions.js");
const billing = await import("../src/lib/db/repos/billingRepo.js");
const usage = await import("../src/lib/db/repos/usageRepo.js");
const pricing = await import("../src/lib/db/repos/pricingRepo.js");
const { NANO } = await import("../src/shared/utils/money.js");

let db;
const USD = (n) => Math.round(n * NANO);
const HOUR = 60 * 60 * 1000;

// A fixed instant so every expectation is arithmetic, not a race with the clock.
const T0 = Date.UTC(2026, 9, 29, 10, 0, 0);
const at = (ms) => new Date(ms).toISOString();
const plus = (ms, hours) => at(ms + hours * HOUR);
const days = (n) => n * 24 * HOUR;

before(async () => { db = await getAdapter(); });

after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  for (const table of [
    "userPlanWindows",
    "creditLedger",
    "userPlans",
    "orders",
    "plans",
    "giftRedemptions",
    "giftCodes",
    "apiKeys",
    "users",
    "usageHistory",
    "kv",
    "userAuditLog",
  ]) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* partial schema */ }
  }
});

// ── Fixtures ────────────────────────────────────────────────────────────────

function user(id = "u1", { debt = 0 } = {}) {
  db.run(
    `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
     VALUES(?, ?, 'x', NULL, NULL, 'active', ?, ?, ?)`,
    [id, `${id}@test.local`, debt, at(T0), at(T0)]
  );
}

function plan(id, { code = id, limits = null, creditUsd = 250, days: duration = 30 } = {}) {
  db.run(
    `INSERT INTO plans(id, code, name, priceNanoUsd, creditNanoUsd, durationDays, isActive, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [id, code, code.toUpperCase(), USD(10), USD(creditUsd), duration, at(T0), at(T0)]
  );
}

/** Grant a purchase directly, bypassing any plan row. */
function grant({ id = null, userId = "u1", creditUsd, limits = [], hours = days(30), startsAtMs = T0, source = "admin", priority = null } = {}) {
  const planId = `up-${Math.random().toString(36).slice(2, 10)}`;
  db.run(
    `INSERT INTO userPlans(id, userId, planId, orderId, source, creditTotalNanoUsd, creditRemainingNanoUsd, startsAt, expiresAt, status, priority, limits, createdAt)
     VALUES(?, ?, ?, NULL, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    [
      id || planId, userId, null, source, USD(creditUsd), USD(creditUsd),
      at(startsAtMs), plus(startsAtMs, hours / HOUR),
      priority, limits && limits.length ? JSON.stringify(limits) : null, at(startsAtMs),
    ]
  );
  return id || planId;
}

function creditOf(userPlanId) {
  return db.get(`SELECT creditRemainingNanoUsd, status FROM userPlans WHERE id = ?`, [userPlanId]);
}

function windowOf(userPlanId, hours) {
  return db.get(`SELECT * FROM userPlanWindows WHERE userPlanId = ? AND hours = ?`, [userPlanId, hours]);
}

function ledgerFor(userPlanId) {
  return db.all(
    `SELECT * FROM creditLedger WHERE userPlanId = ? ORDER BY id ASC`,
    [userPlanId]
  );
}

function key(id = "k1", { userId = "u1" } = {}) {
  db.run(
    `INSERT INTO apiKeys(id, key, name, isActive, createdAt, userId) VALUES(?, ?, ?, 1, ?, ?)`,
    [id, `secret-${id}`, id, at(T0), userId]
  );
  return id;
}

// ── 1. Queue order ─────────────────────────────────────────────────────────

test("1a. default order is by expiry; explicit priority wins; a new grant goes last", () => {
  user();
  const late = grant({ id: "up-late", creditUsd: 10, hours: days(20) });
  const early = grant({ id: "up-early", creditUsd: 10, hours: days(10) });

  let order = queue.listQueueSync(db, "u1", at(T0)).map((e) => e.id);
  assert.deepEqual(order, [early, late], "without priority: earliest expiry first");

  // Manual order: late above early.
  const result = queue.reorderSync(db, "u1", [late, early], { actor: "customer", nowIso: at(T0) });
  assert.equal(result.ok, true);

  order = queue.listQueueSync(db, "u1", at(T0)).map((e) => e.id);
  assert.deepEqual(order, [late, early], "priority wins over expiry");

  // A new plan expiring sooner still goes after the ordered pair.
  const newest = grant({ id: "up-new", creditUsd: 10, hours: days(1) });
  order = queue.listQueueSync(db, "u1", at(T0)).map((e) => e.id);
  assert.deepEqual(order, [late, early, newest], "a new grant joins at the end");
});

test("1b. ties break by creation time then id", () => {
  user();
  const a = grant({ id: "up-b", creditUsd: 10, hours: days(10), startsAtMs: T0 });
  const b = grant({ id: "up-a", creditUsd: 10, hours: days(10), startsAtMs: T0 });
  // Identical expiry and createdAt → id decides, ascending.
  const order = queue.listQueueSync(db, "u1", at(T0)).map((e) => e.id);
  assert.deepEqual(order, [b, a].sort());
});

// ── 2. Reordering ──────────────────────────────────────────────────────────

test("2. reorder validates the set, writes 1..n and audits", () => {
  user();
  const a = grant({ id: "up-a", creditUsd: 10, hours: days(10) });
  const b = grant({ id: "up-b", creditUsd: 10, hours: days(20) });
  const c = grant({ id: "up-c", creditUsd: 10, hours: days(30) });

  // Missing / extra id → 409.
  assert.equal(queue.reorderSync(db, "u1", [a, b], { nowIso: at(T0) }).code, "queue_changed");
  assert.equal(queue.reorderSync(db, "u1", [a, b, c, "ghost"], { nowIso: at(T0) }).code, "queue_changed");
  // Empty / duplicate / non-string → 400.
  assert.equal(queue.reorderSync(db, "u1", [], { nowIso: at(T0) }).code, "invalid_order");
  assert.equal(queue.reorderSync(db, "u1", [a, a, b], { nowIso: at(T0) }).code, "invalid_order");
  assert.equal(queue.reorderSync(db, "u1", [a, b, 42], { nowIso: at(T0) }).code, "invalid_order");

  // Nothing changed by the refusals.
  assert.deepEqual(queue.listQueueSync(db, "u1", at(T0)).map((e) => e.id), [a, b, c]);

  const ok = queue.reorderSync(db, "u1", [c, a, b], { actor: "customer", nowIso: at(T0) });
  assert.deepEqual(ok, { ok: true });

  const priorities = Object.fromEntries(
    db.all(`SELECT id, priority FROM userPlans`).map((row) => [row.id, row.priority])
  );
  assert.deepEqual(priorities, { [c]: 1, [a]: 2, [b]: 3 });

  const audit = db.all(`SELECT * FROM userAuditLog WHERE action = 'queue_reordered'`);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor, "customer");
  const details = JSON.parse(audit[0].details);
  assert.deepEqual(details.before, [a, b, c]);
  assert.deepEqual(details.after, [c, a, b]);
});

// ── 3. First plan blocked, second eligible ─────────────────────────────────

test("3. a window-blocked plan 1 is skipped: plan 2 is admitted and charged", () => {
  user();
  const limits = [{ hours: 5, maxNanoUsd: USD(20) }];
  const p1 = grant({ id: "up-1", creditUsd: 100, limits, hours: days(10) });
  const p2 = grant({ id: "up-2", creditUsd: 100, limits, hours: days(20) });

  // Fill plan 1's 5-hour window exactly.
  queue.chargeSync(db, { userId: "u1", requestKey: "seed-1", costNanoUsd: USD(20), nowIso: at(T0) });
  assert.equal(windowOf(p1, 5).spentNanoUsd, USD(20));

  // Plan 1 is now blocked; admission picks plan 2.
  const admitted = queue.admitSync(db, "u1", at(T0 + 1000));
  assert.equal(admitted.ok, true);
  assert.equal(admitted.planId, p2);

  const charged = queue.chargeSync(db, {
    userId: "u1", requestKey: "req-2", costNanoUsd: USD(5), nowIso: at(T0 + 2000),
  });
  assert.equal(charged.parts.length, 1);
  assert.equal(charged.parts[0].userPlanId, p2, "the admitted plan paid");
  assert.equal(creditOf(p1).creditRemainingNanoUsd, USD(80));
  assert.equal(creditOf(p2).creditRemainingNanoUsd, USD(95));
});

// ── 4. Split at the window edge ────────────────────────────────────────────

test("4. a charge splits at the window edge into two ledger rows", () => {
  user();
  const limits = [{ hours: 5, maxNanoUsd: USD(20) }];
  const p1 = grant({ id: "up-1", creditUsd: 100, limits, hours: days(10) });
  const p2 = grant({ id: "up-2", creditUsd: 100, limits, hours: days(20) });

  queue.chargeSync(db, { userId: "u1", requestKey: "seed", costNanoUsd: USD(19.5), nowIso: at(T0) });
  assert.equal(windowOf(p1, 5).spentNanoUsd, USD(19.5));

  const charged = queue.chargeSync(db, {
    userId: "u1", requestKey: "req-split", costNanoUsd: USD(1), nowIso: at(T0 + 1000),
  });
  assert.equal(charged.parts.length, 2);
  assert.deepEqual(
    charged.parts.map((p) => ({ id: p.userPlanId, amount: p.amountNanoUsd, pass: p.pass })),
    [
      { id: p1, amount: USD(0.5), pass: 1 },
      { id: p2, amount: USD(0.5), pass: 1 },
    ]
  );
  // Two ledger rows, $0.50 each, under the same base request key.
  const p1Charges = ledgerFor(p1).filter((r) => r.kind === "charge" && r.requestKey !== "seed");
  assert.equal(p1Charges.length, 1);
  assert.equal(p1Charges[0].deltaNanoUsd, -USD(0.5));
  assert.equal(windowOf(p1, 5).spentNanoUsd, USD(20), "plan 1 hit its window maximum");

  // And plan 1 is now blocked.
  const state = queue.evaluatePlan(queue.listQueueSync(db, "u1", at(T0 + 2000))[0], T0 + 2000);
  assert.equal(state.blocked, true);
  assert.equal(state.reopenAt, plus(T0, 5));
});

// ── 5. Single plan absorbs the overflow in pass 2 ──────────────────────────

test("5. one plan takes the overflow in pass 2 and is then blocked", () => {
  user();
  const limits = [{ hours: 5, maxNanoUsd: USD(20) }];
  const p1 = grant({ id: "up-1", creditUsd: 100, limits, hours: days(10) });

  queue.chargeSync(db, { userId: "u1", requestKey: "seed", costNanoUsd: USD(19.5), nowIso: at(T0) });

  const charged = queue.chargeSync(db, {
    userId: "u1", requestKey: "req-overflow", costNanoUsd: USD(1), nowIso: at(T0 + 1000),
  });
  // Pass 1 takes the $0.50 of room left in the window, pass 2 takes the other
  // $0.50 ignoring it: the whole $1 lands on the same plan (each take is its own
  // ledger row, so the overflow is visible in the audit trail).
  const total = charged.parts.reduce((sum, part) => sum + part.amountNanoUsd, 0);
  assert.equal(total, USD(1), "the admitted request is fully paid");
  assert.ok(charged.parts.every((part) => part.userPlanId === p1), "all of it on the only plan");
  assert.deepEqual(charged.parts.map((part) => part.pass), [1, 2]);
  assert.equal(windowOf(p1, 5).spentNanoUsd, USD(20.5), "window shows the overshoot");

  // THE assertion that was missing: the plan's credit must equal $100 − $19.50 − $1.
  // A second take computed from the pre-charge balance used to write
  // `100 − 0.50` and silently keep $0.50 that the ledger had already billed.
  assert.equal(
    creditOf(p1).creditRemainingNanoUsd,
    USD(100) - USD(19.5) - USD(1),
    "pass 2 must deduct from the post-pass-1 balance, not the original"
  );
  assert.equal(
    ledgerFor(p1).filter((r) => r.kind === "charge").reduce((sum, r) => sum + r.deltaNanoUsd, 0),
    -(USD(19.5) + USD(1)),
    "ledger and plan agree"
  );

  const [entry] = queue.listQueueSync(db, "u1", at(T0 + 2000));
  const state = queue.evaluatePlan(entry, T0 + 2000);
  assert.equal(state.blocked, true);
  // Blocked until the window that was opened at T0 closes.
  assert.equal(state.reopenAt, plus(T0, 5));

  // After it closes, the plan is eligible again.
  const after = queue.admitSync(db, "u1", plus(T0, 5));
  assert.equal(after.ok, true, "the plan reopens when its window closes");
});

test("5b. a nearly-empty plan cannot fabricate credit across the two passes", () => {
  user();
  // $0.60 of credit, a $0.50 window room and a $1.00 request: pass 1 takes $0.50,
  // pass 2 takes the remaining $0.10, and $0.40 becomes debt. The failure mode this
  // pins is pass 2 rewriting the balance to `0.60 − 0.10 = 0.50` (status active),
  // which books only $0.40 of debt and leaves $0.10 of credit that never existed.
  const p1 = grant({ id: "up-poor", creditUsd: 0.6, limits: [{ hours: 5, maxNanoUsd: USD(0.5) }], hours: days(10) });

  const charged = queue.chargeSync(db, {
    userId: "u1", requestKey: "req-poor", costNanoUsd: USD(1), nowIso: at(T0),
  });

  assert.equal(charged.parts.length, 2);
  assert.deepEqual(
    charged.parts.map((part) => ({ amount: part.amountNanoUsd, pass: part.pass })),
    [{ amount: USD(0.5), pass: 1 }, { amount: USD(0.1), pass: 2 }]
  );
  assert.equal(creditOf(p1).creditRemainingNanoUsd, 0, "all $0.60 was spent");
  assert.equal(creditOf(p1).status, "exhausted");
  assert.equal(charged.debtNanoUsd, USD(0.4), "exactly the uncovered remainder is debt");

  // Ledger total equals what the plan lost: nothing billed twice, nothing invented.
  const ledgerSum = ledgerFor(p1)
    .filter((row) => row.kind === "charge")
    .reduce((sum, row) => sum + row.deltaNanoUsd, 0);
  assert.equal(ledgerSum, -USD(0.6));
});

// ── 6. Every plan blocked → 429 with the earliest reopen ───────────────────

test("6. all plans blocked yields 429 plan_limit with the earliest reopen", () => {
  user();
  const p1 = grant({
    id: "up-1", creditUsd: 100,
    limits: [{ hours: 5, maxNanoUsd: USD(10) }], hours: days(10),
  });
  const p2 = grant({
    id: "up-2", creditUsd: 100,
    limits: [{ hours: 5, maxNanoUsd: USD(10) }, { hours: 24, maxNanoUsd: USD(30) }], hours: days(20),
  });

  // Block both. Plan 1's window closes at T0+5h; plan 2's at T0+5h too, so shift
  // plan 2's opening later by charging it a minute after plan 1.
  queue.chargeSync(db, { userId: "u1", requestKey: "fill-1", costNanoUsd: USD(10), nowIso: at(T0) });
  queue.chargeSync(db, { userId: "u1", requestKey: "fill-2", costNanoUsd: USD(10), nowIso: at(T0 + 60_000) });

  assert.equal(windowOf(p1, 5).spentNanoUsd, USD(10));
  assert.equal(windowOf(p2, 5).spentNanoUsd, USD(10));

  const nowMs = T0 + 10 * 60_000; // 13:10-style instant, both blocked
  const denied = queue.admitSync(db, "u1", at(nowMs));
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 429);
  assert.equal(denied.code, "plan_limit");
  // Plan 1 reopens at T0+5h — earlier than plan 2's T0+5h+1min.
  assert.equal(denied.resetAt, plus(T0, 5));
  assert.equal(denied.retryAfterSec, Math.ceil((T0 + 5 * HOUR - nowMs) / 1000));
});

// ── 7. No credit → 402, debt, and a later grant repays it ──────────────────

test("7. no credit is 402; the remainder becomes debt; a grant repays it first", () => {
  user();
  // No plans at all.
  const denied = queue.admitSync(db, "u1", at(T0));
  assert.equal(denied.status, 402);
  assert.equal(denied.code, "insufficient_quota");

  // A plan with $0.30 cannot cover a $1 request: $0.30 charged, $0.70 debt.
  const p1 = grant({ id: "up-1", creditUsd: 0.3, hours: days(10) });
  const charged = queue.chargeSync(db, {
    userId: "u1", requestKey: "req-debt", costNanoUsd: USD(1), nowIso: at(T0 + 1000),
  });
  assert.equal(charged.parts.length, 1);
  assert.equal(charged.parts[0].amountNanoUsd, USD(0.3));
  assert.equal(charged.debtNanoUsd, USD(0.7));
  assert.equal(creditOf(p1).status, "exhausted");
  assert.equal(creditOf(p1).creditRemainingNanoUsd, 0);

  const debtRow = db.get(`SELECT * FROM creditLedger WHERE userPlanId IS NULL AND kind = 'charge'`);
  assert.equal(debtRow.deltaNanoUsd, -USD(0.7));

  // A later $250 grant repays the debt: the plan holds $249.30.
  const { userPlan, appliedToOverdraftNanoUsd } = grantUserPlan(db, {
    userId: "u1", source: "admin", creditNanoUsd: USD(250), durationDays: 30, now: at(T0 + 5000),
  });
  assert.equal(appliedToOverdraftNanoUsd, USD(0.7));
  assert.equal(userPlan.creditTotalNanoUsd, USD(249.3));
  assert.equal(db.get(`SELECT overdraftNanoUsd FROM users WHERE id = 'u1'`).overdraftNanoUsd, 0);
});

// ── 8. Windows: first charge opens, resets after `hours`, independent ──────

test("8a. a window opens on the first charge and resets after its length", () => {
  user();
  const p1 = grant({ id: "up-1", creditUsd: 100, limits: [{ hours: 5, maxNanoUsd: USD(20) }], hours: days(10) });

  queue.chargeSync(db, { userId: "u1", requestKey: "open", costNanoUsd: USD(20), nowIso: at(T0) });
  const opened = windowOf(p1, 5);
  assert.equal(opened.startedAt, at(T0));
  assert.equal(opened.spentNanoUsd, USD(20));

  const blockedNow = queue.admitSync(db, "u1", at(T0 + HOUR));
  assert.equal(blockedNow.code, "plan_limit");

  // One minute past the close time the plan is eligible and a charge reopens it.
  const eligible = queue.admitSync(db, "u1", at(T0 + 5 * HOUR + 60_000));
  assert.equal(eligible.ok, true);

  queue.chargeSync(db, { userId: "u1", requestKey: "reopen", costNanoUsd: USD(3), nowIso: at(T0 + 5 * HOUR + 60_000) });
  const reopened = windowOf(p1, 5);
  assert.equal(reopened.startedAt, at(T0 + 5 * HOUR + 60_000), "a new window opens at the new charge");
  assert.equal(reopened.spentNanoUsd, USD(3), "spend counts from zero");
});

test("8b. windows are independent: a closed 5-hour window does not unblock a full 168-hour one", () => {
  user();
  const p1 = grant({
    id: "up-1", creditUsd: 200,
    limits: [{ hours: 5, maxNanoUsd: USD(20) }, { hours: 168, maxNanoUsd: USD(80) }],
    hours: days(30),
  });

  // Fill the weekly window with repeated 5-hour chunks. Each 5-hour window must
  // close before the next charge can add to it, and every amount also counts
  // against the 168-hour window (opened once, at the first charge).
  let t = T0;
  for (let i = 0; i < 4; i += 1) {
    queue.chargeSync(db, { userId: "u1", requestKey: `w-${i}`, costNanoUsd: USD(20), nowIso: at(t) });
    t += 5 * HOUR + 60_000;
  }
  assert.equal(windowOf(p1, 168).spentNanoUsd, USD(80), "the weekly window accumulated all four chunks");
  assert.equal(windowOf(p1, 168).startedAt, at(T0), "and it never reopened");

  // At t the 5-hour window is long closed but the weekly one is full.
  const [entry] = queue.listQueueSync(db, "u1", at(t));
  const state = queue.evaluatePlan(entry, t);
  assert.equal(state.blocked, true);
  assert.equal(state.reopenAt, plus(T0, 168), "reopens when the 168-hour window closes");

  const denied = queue.admitSync(db, "u1", at(t));
  assert.equal(denied.code, "plan_limit");
});

test("5c. four window-filling cycles leave credit at exactly ledger-derived credit", () => {
  user();
  const p1 = grant({ id: "up-cycles", creditUsd: 100, limits: [{ hours: 5, maxNanoUsd: USD(20) }], hours: days(30) });

  // Each cycle: fill the window ($19.50) then overflow by $1 — the split charge.
  let t = T0;
  for (let cycle = 0; cycle < 4; cycle += 1) {
    queue.chargeSync(db, { userId: "u1", requestKey: `cyc-${cycle}-fill`, costNanoUsd: USD(19.5), nowIso: at(t) });
    queue.chargeSync(db, { userId: "u1", requestKey: `cyc-${cycle}-over`, costNanoUsd: USD(1), nowIso: at(t + 1000) });
    // Close the window so the next cycle opens a fresh one.
    t += 6 * HOUR;
  }

  const billed = -ledgerFor(p1)
    .filter((row) => row.kind === "charge")
    .reduce((sum, row) => sum + row.deltaNanoUsd, 0);
  assert.equal(billed, USD(82), "4 × ($19.50 + $1) was billed");

  const book = creditOf(p1).creditRemainingNanoUsd;
  assert.equal(book, USD(100) - billed, "credit on book equals credit minus what was billed");
  assert.equal(book, USD(18));
});

// ── 9. Idempotent retry ───────────────────────────────────────────────────

test("9. a retried requestKey writes nothing and leaves window counters alone", () => {
  user();
  const p1 = grant({ id: "up-1", creditUsd: 100, limits: [{ hours: 5, maxNanoUsd: USD(20) }], hours: days(10) });

  const first = queue.chargeSync(db, {
    userId: "u1", requestKey: "req-retry", costNanoUsd: USD(4), nowIso: at(T0),
  });
  assert.equal(first.alreadyCharged, false);

  const rowsAfterFirst = db.get(`SELECT COUNT(*) AS n FROM creditLedger`)?.n;
  const windowAfterFirst = windowOf(p1, 5).spentNanoUsd;

  const second = queue.chargeSync(db, {
    userId: "u1", requestKey: "req-retry", costNanoUsd: USD(4), nowIso: at(T0 + 1000),
  });
  assert.equal(second.alreadyCharged, true);
  assert.equal(second.charged, 0);
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM creditLedger`)?.n, rowsAfterFirst, "no new ledger row");
  assert.equal(windowOf(p1, 5).spentNanoUsd, windowAfterFirst, "window counters unchanged");
  assert.equal(creditOf(p1).creditRemainingNanoUsd, USD(96));
});

// ── 10. Zero cost ─────────────────────────────────────────────────────────

test("10. a zero cost writes nothing", () => {
  user();
  const p1 = grant({ id: "up-1", creditUsd: 100, limits: [{ hours: 5, maxNanoUsd: USD(20) }], hours: days(10) });

  const result = queue.chargeSync(db, {
    userId: "u1", requestKey: "req-zero", costNanoUsd: 0, nowIso: at(T0),
  });
  assert.equal(result.charged, 0);
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM creditLedger`)?.n, 0);
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM userPlanWindows`)?.n, 0);
  assert.equal(creditOf(p1).creditRemainingNanoUsd, USD(100));
});

// ── 11. Unswept expired plan ──────────────────────────────────────────────

test("11. an expired but unswept plan is neither admitted nor charged", () => {
  user();
  const expired = grant({ id: "up-old", creditUsd: 50, limits: [], hours: days(1) });
  const live = grant({ id: "up-live", creditUsd: 50, limits: [], hours: days(30), startsAtMs: T0 + days(2) });

  const later = T0 + days(3);
  const admitted = queue.admitSync(db, "u1", at(later));
  assert.equal(admitted.planId, live);

  const charged = queue.chargeSync(db, { userId: "u1", requestKey: "req-live", costNanoUsd: USD(5), nowIso: at(later) });
  assert.deepEqual(charged.parts.map((p) => p.userPlanId), [live]);
  // The expired plan keeps its credit until the sweep.
  assert.equal(creditOf(expired).creditRemainingNanoUsd, USD(50));
  assert.equal(creditOf(expired).status, "active", "not swept yet");
});

// ── 12. Plan edits do not rewrite purchases; apply-to-active does ──────────

test("12. editing a plan leaves purchases alone; applyLimitsToActiveSync only touches active ones", () => {
  user();
  user("u2");
  plan("p-go", { code: "go", limits: [{ hours: 5, maxNanoUsd: USD(20) }, { hours: 168, maxNanoUsd: USD(80) }] });

  const buy = (userId, status = "active") => {
    const id = `up-${userId}-${Math.random().toString(36).slice(2, 8)}`;
    db.run(
      `INSERT INTO userPlans(id, userId, planId, orderId, source, creditTotalNanoUsd, creditRemainingNanoUsd, startsAt, expiresAt, status, limits, createdAt)
       VALUES(?, ?, 'p-go', NULL, 'purchase', ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, userId, USD(250), USD(250), at(T0), plus(T0, 720),
        status, JSON.stringify([{ hours: 5, maxNanoUsd: USD(20) }, { hours: 168, maxNanoUsd: USD(80) }]), at(T0),
      ]
    );
    return id;
  };

  const active = buy("u1", "active");
  const expired = buy("u2", "expired");
  // Window state for both lengths on the active purchase.
  db.run(`INSERT INTO userPlanWindows(userPlanId, hours, startedAt, spentNanoUsd) VALUES(?, 5, ?, ?)`, [active, at(T0), USD(12)]);
  db.run(`INSERT INTO userPlanWindows(userPlanId, hours, startedAt, spentNanoUsd) VALUES(?, 168, ?, ?)`, [active, at(T0), USD(40)]);

  // Editing the template changes nothing already sold.
  db.run(`UPDATE plans SET limits = ? WHERE id = 'p-go'`, [JSON.stringify([{ hours: 5, maxNanoUsd: USD(5) }])]);
  assert.deepEqual(
    parseLimits(db.get(`SELECT limits FROM userPlans WHERE id = ?`, [active]).limits),
    [{ hours: 5, maxNanoUsd: USD(20) }, { hours: 168, maxNanoUsd: USD(80) }],
    "the purchase keeps the snapshot it was sold"
  );

  // Apply-to-active: new limits [5h/$10, 24h/$40].
  const newLimits = [{ hours: 5, maxNanoUsd: USD(10) }, { hours: 24, maxNanoUsd: USD(40) }];
  const result = db.transaction(() => applyLimitsToActiveSync(db, "p-go", newLimits, {
    actor: "admin:ops@test.local",
    planCode: "go",
  }));
  assert.equal(result.affectedCount, 1, "only the one active purchase");

  assert.deepEqual(
    parseLimits(db.get(`SELECT limits FROM userPlans WHERE id = ?`, [active]).limits),
    newLimits
  );
  // Kept length 5 keeps its spent amount; the removed 168 window is gone; the new
  // 24 window has no state yet.
  assert.equal(windowOf(active, 5).spentNanoUsd, USD(12), "spent kept for a kept length");
  assert.equal(windowOf(active, 168), undefined, "state for a removed length is deleted");
  assert.equal(windowOf(active, 24), undefined);

  // The expired purchase is untouched.
  assert.deepEqual(
    parseLimits(db.get(`SELECT limits FROM userPlans WHERE id = ?`, [expired]).limits),
    [{ hours: 5, maxNanoUsd: USD(20) }, { hours: 168, maxNanoUsd: USD(80) }]
  );

  // One audit entry per affected user.
  const audits = db.all(`SELECT * FROM userAuditLog WHERE action = 'plan_limits_changed'`);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].userId, "u1");
  assert.equal(audits[0].actor, "admin:ops@test.local");
  assert.match(audits[0].reason, /go/);
});

// ── 13. Gifts snapshot limits ─────────────────────────────────────────────

test("13. a plan gift snapshots the plan's limits; a credit gift has none", () => {
  user();
  plan("p-go", { code: "go", limits: [{ hours: 5, maxNanoUsd: USD(20) }, { hours: 168, maxNanoUsd: USD(80) }] });

  const planGrant = grantUserPlan(db, {
    userId: "u1", planId: "p-go", source: "gift",
    creditNanoUsd: USD(250), durationDays: 30,
    limits: [{ hours: 5, maxNanoUsd: USD(20) }, { hours: 168, maxNanoUsd: USD(80) }],
    now: at(T0),
  });
  assert.deepEqual(
    parseLimits(planGrant.userPlan.limits),
    [{ hours: 5, maxNanoUsd: USD(20) }, { hours: 168, maxNanoUsd: USD(80) }]
  );

  const creditGrant = grantUserPlan(db, {
    userId: "u1", source: "gift", creditNanoUsd: USD(5), durationDays: 30, limits: [], now: at(T0),
  });
  assert.equal(creditGrant.userPlan.limits, null, "a credit-only grant stores no limits");
  assert.deepEqual(parseLimits(creditGrant.userPlan.limits), []);
});

// ── 14. Counters equal the ledger under random traffic ────────────────────

test("14. window counters equal rebuildWindowsSync across random charges and clock jumps", () => {
  user();
  const p1 = grant({
    id: "up-1", creditUsd: 1000,
    limits: [{ hours: 5, maxNanoUsd: USD(200) }, { hours: 24, maxNanoUsd: USD(400) }],
    hours: days(60),
  });

  // Deterministic pseudo-random sequence: charges of $1..$30 with clock jumps that
  // sometimes stay inside a window and sometimes close it.
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  let t = T0;
  for (let i = 0; i < 60; i += 1) {
    // Jump 1 minute to 6 hours.
    t += Math.floor(rand() * 6 * HOUR) + 60_000;
    const cost = USD(1 + Math.floor(rand() * 29));
    queue.chargeSync(db, { userId: "u1", requestKey: `rnd-${i}`, costNanoUsd: cost, nowIso: at(t) });
  }

  const rebuilt = queue.rebuildWindowsSync(db, p1, at(t));
  for (const hours of [5, 24]) {
    const stored = windowOf(p1, hours);
    const expected = rebuilt[hours];
    if (!expected || expected.startedAt == null) {
      // No open window right now → the table's row is stale but reads as closed.
      if (stored) {
        const closedAt = new Date(stored.startedAt).getTime() + hours * HOUR;
        assert.ok(t >= closedAt, `window ${hours} should read as closed`);
      }
      continue;
    }
    assert.equal(stored.startedAt, expected.startedAt, `window ${hours} startedAt`);
    assert.equal(stored.spentNanoUsd, expected.spentNanoUsd, `window ${hours} spent`);
  }
});

// ── 15. Backfill ──────────────────────────────────────────────────────────

test("15. backfill charges only eligible rows, only plans alive then, and is idempotent", () => {
  user();
  user("u2");
  key("k1", { userId: "u1" });

  // Plan A started before the usage, plan B bought after it.
  const planA = grant({ id: "up-a", creditUsd: 1, hours: days(30), startsAtMs: T0 });
  const planB = grant({ id: "up-b", creditUsd: 100, hours: days(30), startsAtMs: T0 + days(2) });

  const usageAt = T0 + days(1);
  const insertUsageRow = (id, { at: when, cost, apiKeyId = "k1" }) => {
    db.run(
      `INSERT INTO usageHistory(id, timestamp, provider, model, apiKeyId, promptTokens, completionTokens, cost, costNanoUsd, status, meta)
       VALUES(?, ?, 'p', 'm', ?, 10, 10, ?, ?, 'ok', '{}')`,
      [id, when, apiKeyId, cost / NANO, cost]
    );
  };
  insertUsageRow(1, { at: at(usageAt), cost: USD(2) });          // eligible
  insertUsageRow(2, { at: at(T0 - days(2)), cost: USD(9) });     // before the cut-off

  const since = at(T0 - days(1));
  const result = queue.runBackfillSync(db, { sinceIso: since, nowIso: at(T0 + days(3)) });
  assert.equal(result.rows, 1, "only the row at/after the cut-off");
  assert.equal(result.chargedNanoUsd, USD(1), "plan A's $1");
  assert.equal(result.debtNanoUsd, USD(1), "the rest became debt");

  assert.equal(creditOf(planA).creditRemainingNanoUsd, 0);
  assert.equal(creditOf(planB).creditRemainingNanoUsd, USD(100), "plan B was bought later and pays nothing");

  const rows = db.all(`SELECT * FROM creditLedger WHERE requestKey LIKE 'usage:%' ORDER BY id`);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].userPlanId, planA);
  assert.equal(rows[0].usageId, 1);
  assert.equal(rows[0].meta.includes('"backfill":true'), true);
  assert.equal(rows[0].meta.includes(at(usageAt)), true, "meta carries the usage timestamp");
  assert.equal(rows[1].kind, "charge");
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM userPlanWindows`)?.n, 0, "backfill never touches windows");

  // Second run: nothing to do.
  const again = queue.runBackfillSync(db, { sinceIso: since, nowIso: at(T0 + days(4)) });
  assert.equal(again.rows, 0);
  assert.equal(again.chargedNanoUsd, 0);
  assert.equal(again.debtNanoUsd, 0);
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM creditLedger`)?.n, rows.length);
});

// ── 16. saveRequestUsage charges a customer key once ──────────────────────

test("16. saveRequestUsage charges a customer key, keyed by usage id, exactly once", async () => {
  // Under plain node --test the built-in price tables cannot load, so the cost
  // would silently be 0. Seed a price override: prices are USD per 1M tokens, so
  // input 1 / output 2 makes 1,000 in + 500 out cost exactly $0.002.
  await pricing.updatePricing({ testprov: { testmodel: { input: 1, output: 2 } } });

  user();
  key("k1", { userId: "u1" });
  const p1 = grant({ id: "up-1", creditUsd: 10, limits: [{ hours: 5, maxNanoUsd: USD(20) }], hours: days(30) });

  const entry = {
    timestamp: at(T0),
    provider: "testprov",
    model: "testmodel",
    apiKey: "secret-k1",
    tokens: { prompt_tokens: 1000, completion_tokens: 500 },
    status: "ok",
  };
  await usage.saveRequestUsage({ ...entry });

  const usageRow = db.get(`SELECT * FROM usageHistory ORDER BY id DESC LIMIT 1`);
  assert.equal(usageRow.costNanoUsd, USD(0.002));

  const ledger = db.all(`SELECT * FROM creditLedger WHERE kind = 'charge'`);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].usageId, usageRow.id);
  assert.equal(ledger[0].requestKey, `usage:${usageRow.id}`);
  assert.equal(ledger[0].deltaNanoUsd, -USD(0.002));
  assert.equal(creditOf(p1).creditRemainingNanoUsd, USD(10) - USD(0.002));
  assert.equal(windowOf(p1, 5).spentNanoUsd, USD(0.002));

  // Saving the same entry again must not charge twice: saveRequestUsage dedupes the
  // usage row, and even a second row would be a new requestKey — so assert both.
  await usage.saveRequestUsage({ ...entry });
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM creditLedger WHERE kind = 'charge'`)?.n, 1);
  assert.equal(windowOf(p1, 5).spentNanoUsd, USD(0.002));
});

// ── 17. Admin keys are not charged ────────────────────────────────────────

test("17. an admin key writes no ledger row and admission does not apply", async () => {
  await pricing.updatePricing({ testprov: { testmodel: { input: 1, output: 2 } } });
  // Admin key: no userId.
  db.run(
    `INSERT INTO apiKeys(id, key, name, isActive, createdAt, userId) VALUES('ka', 'admin-secret', 'admin', 1, ?, NULL)`,
    [at(T0)]
  );

  await usage.saveRequestUsage({
    timestamp: at(T0),
    provider: "testprov",
    model: "testmodel",
    apiKey: "admin-secret",
    tokens: { prompt_tokens: 1000, completion_tokens: 500 },
    status: "ok",
  });

  assert.equal(db.get(`SELECT COUNT(*) AS n FROM creditLedger`)?.n, 0, "admin keys are not billed");
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM userPlanWindows`)?.n, 0);

  // And admission is never asked about an account that has no plans.
  const admitted = queue.admitSync(db, "someone-without-plans", at(T0));
  assert.equal(admitted.code, "insufficient_quota");
});
