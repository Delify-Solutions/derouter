// Debt write-off (change debt-clear): unlimited plans take over older debt, and
// an admin can clear it with a reason.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-debt-clear-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const queue = await import("../src/lib/billing/planQueue.js");
const { grantUserPlan } = await import("../src/lib/billing/grants.js");
const actions = await import("../src/lib/billing/adminActions.js");
const { getAccountLedgerSync } = await import("../src/lib/db/repos/accountPlansRepo.js");

const USD = (n) => Math.round(n * 1e9);
const T0 = Date.UTC(2026, 10, 1, 10, 0, 0);
const at = (ms) => new Date(ms).toISOString();
let db;

before(async () => { db = await getAdapter(); });
after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(() => {
  for (const table of ["userPlanWindows", "creditLedger", "userPlans", "users", "userAuditLog"]) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* ignore */ }
  }
  db.run(
    `INSERT INTO users(id, email, passwordHash, status, overdraftNanoUsd, createdAt, updatedAt)
     VALUES('u1', 'u1@test.local', 'x', 'active', ?, ?, ?)`,
    [USD(0.0383), at(T0), at(T0)]
  );
});

const debt = () => db.get(`SELECT overdraftNanoUsd AS d FROM users WHERE id = 'u1'`).d;
const grant = (opts) => db.transaction(() => grantUserPlan(db, { userId: "u1", source: "admin", durationDays: 30, now: at(T0), ...opts }));

test("an unlimited grant writes the whole debt off and reports it", () => {
  const res = grant({ unlimitedCredit: true, limits: [{ hours: 5, maxNanoUsd: USD(20) }] });
  assert.equal(debt(), 0);
  assert.equal(res.appliedToOverdraftNanoUsd, USD(0.0383));
  const row = db.get(`SELECT * FROM creditLedger WHERE kind = 'adjust'`);
  assert.equal(row.deltaNanoUsd, USD(0.0383));
  assert.equal(row.userPlanId, res.userPlan.id);
  assert.equal(JSON.parse(row.meta).reason, "overdraft_absorbed");
});

test("a finite grant still repays only what its credit covers", () => {
  db.run(`UPDATE users SET overdraftNanoUsd = ? WHERE id = 'u1'`, [USD(5)]);
  const res = grant({ creditNanoUsd: USD(2) });
  assert.equal(debt(), USD(3));
  assert.equal(res.appliedToOverdraftNanoUsd, USD(2));
});

test("an account that already holds an unlimited plan is cleared by its next paid request", () => {
  db.run(`UPDATE users SET overdraftNanoUsd = 0 WHERE id = 'u1'`);
  grant({ unlimitedCredit: true, limits: [{ hours: 5, maxNanoUsd: USD(20) }] });
  // Debt from before the rule existed.
  db.run(`UPDATE users SET overdraftNanoUsd = ? WHERE id = 'u1'`, [USD(0.0383)]);
  db.transaction(() => queue.chargeSync(db, { userId: "u1", requestKey: "r1", costNanoUsd: USD(1), nowIso: at(T0 + 1000) }));
  assert.equal(debt(), 0);
  const notes = getAccountLedgerSync(db, "u1", { pageSize: 50 }).entries.map((e) => e.debtNote).filter(Boolean);
  assert.ok(notes.includes("gói không giới hạn trả nợ"));
});

test("with no plan a shortfall still becomes debt", () => {
  db.transaction(() => queue.chargeSync(db, { userId: "u1", requestKey: "r2", costNanoUsd: USD(1), nowIso: at(T0) }));
  assert.equal(debt(), USD(1.0383));
});

test("an admin clears the debt with a reason, guarded by the amount seen", () => {
  const clear = (opts) => db.transaction(() => actions.clearDebtSync(db, "u1", { actor: "admin:test", now: at(T0), ...opts }));
  assert.equal(clear({ reason: "x", expectNanoUsd: USD(0.0383) }).status, 400, "reason required");
  assert.equal(clear({ reason: "nợ lẻ" }).status, 400, "the amount seen is required");
  assert.equal(clear({ reason: "nợ lẻ", expectNanoUsd: USD(1) }).status, 409, "amount changed");
  assert.equal(debt(), USD(0.0383));

  const ok = clear({ reason: "nợ lẻ khi hết gói", expectNanoUsd: USD(0.0383) });
  assert.equal(ok.ok, true);
  assert.equal(ok.clearedNanoUsd, USD(0.0383));
  assert.equal(debt(), 0);
  const audit = db.get(`SELECT action, reason, actor FROM userAuditLog WHERE userId = 'u1'`);
  assert.deepEqual([audit.action, audit.reason, audit.actor], ["debt_cleared", "nợ lẻ khi hết gói", "admin:test"]);
  assert.equal(JSON.parse(db.get(`SELECT meta FROM creditLedger WHERE kind = 'adjust'`).meta).reason, "debt_cleared");

  assert.equal(clear({ reason: "lần hai", expectNanoUsd: 0 }).status, 409, "no debt left");
});

test("debt from a key pinned to a finite plan, recorded after the unlimited plan started, stays", () => {
  db.run(`UPDATE users SET overdraftNanoUsd = 0 WHERE id = 'u1'`);
  db.run(
    `INSERT INTO plans(id, code, name, priceNanoUsd, creditNanoUsd, durationDays, isActive, createdAt, updatedAt)
     VALUES('p-fin', 'fin', 'Fin', 1, ?, 30, 1, ?, ?)`,
    [USD(1), at(T0), at(T0)]
  );
  grant({ planId: "p-fin", creditNanoUsd: USD(1) });
  grant({ unlimitedCredit: true, limits: [{ hours: 5, maxNanoUsd: USD(20) }] });
  // Pinned to the finite plan: $3 against $1 → $2 debt.
  db.transaction(() => queue.chargeSync(db, { userId: "u1", requestKey: "pin", costNanoUsd: USD(3), planId: "p-fin", nowIso: at(T0 + 1000) }));
  assert.equal(debt(), USD(2));
  // A request paid by the unlimited plan does not wipe that new debt.
  db.transaction(() => queue.chargeSync(db, { userId: "u1", requestKey: "free", costNanoUsd: USD(0.01), nowIso: at(T0 + 2000) }));
  assert.equal(debt(), USD(2));
});

test("a retried request writes nothing off twice; a multi-period unlimited grant writes one row", () => {
  const res = grant({ unlimitedCredit: true, periods: 3, limits: [{ hours: 5, maxNanoUsd: USD(20) }] });
  assert.equal(res.userPlans.length, 3);
  const rows = db.all(`SELECT userPlanId, balanceAfterNanoUsd FROM creditLedger WHERE kind = 'adjust'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].userPlanId, res.userPlans[0].id);

  db.run(`UPDATE users SET overdraftNanoUsd = ? WHERE id = 'u1'`, [USD(1)]);
  db.run(`UPDATE userPlans SET startsAt = ? WHERE id = ?`, [at(T0 + 500), res.userPlans[0].id]);
  db.run(`DELETE FROM creditLedger WHERE kind = 'charge'`);
  const once = () => db.transaction(() => queue.chargeSync(db, { userId: "u1", requestKey: "same", costNanoUsd: USD(0.5), nowIso: at(T0 + 1000) }));
  once();
  assert.equal(once().alreadyCharged, true);
  assert.equal(db.all(`SELECT id FROM creditLedger WHERE kind = 'adjust'`).length, 2, "one more write-off, not two");
  assert.equal(debt(), 0);
});
