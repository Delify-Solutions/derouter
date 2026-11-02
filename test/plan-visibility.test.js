// The rate and plan details the account and /usage pages show (spec customer-portal
// "Plan details on the account and usage pages"): RPM/TPM come from the plan that is
// paying, through the same function enforcement uses.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-plan-visibility-"));
// DATA_DIR must be set before the DB driver is imported.
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const repo = await import("../src/lib/db/repos/billingRepo.js");
const { grantPlanSync } = await import("../src/lib/billing/adminActions.js");
const { payingRatesSync } = await import("../src/lib/billing/rates.js");
const { getQueueSync } = await import("../src/lib/db/repos/accountPlansRepo.js");
const { chargeSync } = await import("../src/lib/billing/planQueue.js");

let db;
const USD = (n) => Math.round(n * 1e9);

before(async () => { db = await getAdapter(); });
after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(() => {
  for (const table of ["userPlanWindows", "creditLedger", "userPlans", "orders", "plans", "users", "auditLog"]) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* table may not exist */ }
  }
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
     VALUES('u1', 'u1@test.local', 'x', NULL, NULL, 'active', 0, ?, ?)`,
    [now, now]
  );
});

let seq = 0;
const plan = (overrides = {}) => repo.createPlan({
  code: `vis-${++seq}`, name: `Vis ${seq}`, priceNanoUsd: USD(10), creditNanoUsd: USD(100), durationDays: 30, ...overrides,
});

test("no plan paying: no RPM/TPM applies", () => {
  assert.deepEqual(payingRatesSync(db, "u1"), { userPlanId: null, planId: null, planName: null, rpm: null, tpm: null });
});

test("the paying plan's RPM/TPM and name are reported, and each queue entry carries its own", async () => {
  const fast = await plan({ name: "Fast", rpm: 60, tpm: 200000 });
  const open = await plan({ name: "Open" });
  const a = grantPlanSync(db, "u1", { planId: fast.id, reason: "test a" }).userPlan;
  grantPlanSync(db, "u1", { planId: open.id, reason: "test b" });

  const rate = payingRatesSync(db, "u1");
  assert.equal(rate.userPlanId, a.id);
  assert.equal(rate.planName, "Fast");
  assert.equal(rate.rpm, 60);
  assert.equal(rate.tpm, 200000);

  const queue = getQueueSync(db, "u1");
  assert.deepEqual(queue.map((e) => [e.planName, e.rpm, e.tpm]), [["Fast", 60, 200000], ["Open", null, null]]);
  assert.ok(queue.every((e) => e.startsAt && e.expiresAt), "start and expiry for every entry");
});

test("when the first plan is window-blocked, the next plan's rates apply", async () => {
  const capped = await plan({ name: "Capped", rpm: 10, limits: [{ hours: 5, maxNanoUsd: USD(1) }] });
  const backup = await plan({ name: "Backup", rpm: 99 });
  grantPlanSync(db, "u1", { planId: capped.id, reason: "test a" });
  grantPlanSync(db, "u1", { planId: backup.id, reason: "test b" });
  chargeSync(db, { userId: "u1", requestKey: "r1", costNanoUsd: USD(1) });

  const rate = payingRatesSync(db, "u1");
  assert.equal(rate.planName, "Backup");
  assert.equal(rate.rpm, 99);
  const windows = getQueueSync(db, "u1")[0].windows;
  assert.equal(windows[0].maxNanoUsd, USD(1), "the limit's maximum is always in the payload");
});
