// Per-purchase RPM/TPM override (spec plan-templates "Per-purchase rate
// override") and the gift-code RPM/TPM, edit and delete rules (spec gift-codes).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-rate-overrides-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const repo = await import("../src/lib/db/repos/billingRepo.js");
const { grantPlanSync, grantCreditSync, setPurchaseRatesSync } = await import("../src/lib/billing/adminActions.js");
const { payingRatesSync } = await import("../src/lib/billing/rates.js");
const { ratePlanIdSync } = await import("../src/lib/billing/planQueue.js");
const { getQueueSync } = await import("../src/lib/db/repos/accountPlansRepo.js");
const gifts = await import("../src/lib/db/repos/giftRepo.js");

let db;
const USD = (n) => Math.round(n * 1e9);

before(async () => { db = await getAdapter(); });
after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(() => {
  for (const table of ["giftRedemptions", "giftCodes", "userPlanWindows", "creditLedger", "userPlans", "plans", "users", "userAuditLog"]) {
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
  code: `ro-${++seq}`, name: `Ro ${seq}`, priceNanoUsd: USD(10), creditNanoUsd: USD(100), durationDays: 30, ...overrides,
});

test("a purchase override wins over its plan; empty follows the plan; 0 removes the limit", async () => {
  const p = await plan({ rpm: 60, tpm: 100000 });
  const up = grantPlanSync(db, "u1", { planId: p.id, reason: "test" }).userPlan;
  assert.equal(payingRatesSync(db, "u1").rpm, 60);

  const set = setPurchaseRatesSync(db, "u1", up.id, { rpm: "600", tpm: "", reason: "VIP customer" });
  assert.equal(set.ok, true);
  let rate = payingRatesSync(db, "u1");
  assert.deepEqual([rate.rpm, rate.tpm, rate.rateKey], [600, 100000, p.id], "TPM still follows the plan");
  assert.deepEqual(getQueueSync(db, "u1").map((e) => [e.rpm, e.rpmOverride, e.tpmOverride]), [[600, 600, null]]);

  setPurchaseRatesSync(db, "u1", up.id, { rpm: 0, tpm: null, reason: "no rpm cap" });
  rate = payingRatesSync(db, "u1");
  assert.equal(rate.rpm, null, "0 = no limit");

  const audit = db.all(`SELECT details FROM userAuditLog WHERE userId = 'u1' AND action = 'plan_rates_changed' ORDER BY rowid`);
  assert.equal(audit.length, 2);
  assert.deepEqual(JSON.parse(audit[0].details).after, { rpm: 600, tpm: null });
});

test("the override is refused without a reason, with bad numbers, or when it would unbound an unlimited purchase", async () => {
  const p = await plan({ unlimitedCredit: true, creditNanoUsd: 0, rpm: 30 });
  const up = grantPlanSync(db, "u1", { planId: p.id, reason: "test" }).userPlan;
  assert.equal(setPurchaseRatesSync(db, "u1", up.id, { rpm: 10, reason: "" }).status, 400);
  assert.equal(setPurchaseRatesSync(db, "u1", up.id, { rpm: -1, reason: "bad" }).status, 400);
  assert.equal(setPurchaseRatesSync(db, "u1", up.id, { rpm: "1.5", reason: "bad" }).status, 400);
  const unbounded = setPurchaseRatesSync(db, "u1", up.id, { rpm: 0, tpm: 0, reason: "remove all" });
  assert.equal(unbounded.status, 400);
  assert.match(unbounded.error, /cần ít nhất một hạn mức/);
  assert.equal(setPurchaseRatesSync(db, "u1", "nope", { rpm: 1, reason: "missing" }).status, 404);
});

test("a planless purchase with an override gets its own allowance", () => {
  const up = grantCreditSync(db, "u1", { amountNanoUsd: USD(5), durationDays: 7, reason: "test" }).userPlan;
  assert.equal(payingRatesSync(db, "u1").rateKey, null, "no plan, no override: nothing to count");
  setPurchaseRatesSync(db, "u1", up.id, { rpm: 20, reason: "cap credit" });
  const rate = payingRatesSync(db, "u1");
  assert.equal(rate.rpm, 20);
  assert.equal(rate.rateKey, `purchase:${up.id}`);
  assert.equal(ratePlanIdSync(db, "u1"), rate.rateKey, "usage is recorded under the same allowance it is checked against");
});

test("a gift code's RPM/TPM rides on the purchase it grants", async () => {
  const credit = await gifts.createGiftCode({ code: "RATEGIFT", grantKind: "credit", creditNanoUsd: USD(5), durationDays: 7, rpm: 15, tpm: "" });
  assert.equal(credit.rpm, 15);
  assert.equal(credit.tpm, null);
  const res = db.transaction(() => gifts.redeemGiftCode(db, { userId: "u1", code: "RATEGIFT" }));
  assert.equal(res.ok, true);
  const row = db.get(`SELECT rpm, tpm FROM userPlans WHERE id = ?`, [res.userPlan.id]);
  assert.deepEqual([row.rpm, row.tpm], [15, null]);
  assert.equal(payingRatesSync(db, "u1").rpm, 15);
  await assert.rejects(gifts.createGiftCode({ grantKind: "credit", creditNanoUsd: USD(1), durationDays: 1, rpm: -5 }), /RPM/);
});

test("every field of a gift code is editable, the code string included", async () => {
  const g = await gifts.createGiftCode({ code: "OLDNAME", grantKind: "credit", creditNanoUsd: USD(5), durationDays: 7, maxRedemptions: 3 });
  db.transaction(() => gifts.redeemGiftCode(db, { userId: "u1", code: "OLDNAME" }));
  const other = await gifts.createGiftCode({ code: "TAKEN1", grantKind: "credit", creditNanoUsd: USD(1), durationDays: 1 });

  const renamed = await gifts.updateGiftCode(g.id, { code: "new-name", rpm: 30, tpm: 9000, creditNanoUsd: USD(7) });
  assert.equal(renamed.code, "NEWNAME");
  assert.deepEqual([renamed.rpm, renamed.tpm, renamed.creditNanoUsd], [30, 9000, USD(7)]);
  db.run(`INSERT INTO users(id, email, passwordHash, status, overdraftNanoUsd, createdAt, updatedAt) VALUES('u2','u2@t','x','active',0,?,?)`, [new Date().toISOString(), new Date().toISOString()]);
  assert.equal(db.transaction(() => gifts.redeemGiftCode(db, { userId: "u2", code: "OLDNAME" })).reason, "not_found");
  assert.equal(db.transaction(() => gifts.redeemGiftCode(db, { userId: "u2", code: "NEWNAME" })).ok, true);

  await assert.rejects(gifts.updateGiftCode(g.id, { code: "TAKEN1" }), /đã tồn tại/);
  await assert.rejects(gifts.updateGiftCode(g.id, { code: "ab" }), /4/);
  await assert.rejects(gifts.updateGiftCode(g.id, { startsAt: "2099-02-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" }), /trước ngày hết hạn/);
  assert.ok(other);
});

test("deleting a gift code: unused is removed, used is hidden but keeps its history", async () => {
  const unused = await gifts.createGiftCode({ code: "UNUSED1", grantKind: "credit", creditNanoUsd: USD(1), durationDays: 1 });
  assert.deepEqual(await gifts.deleteGiftCode(unused.id), { deleted: "hard" });
  assert.equal(db.get(`SELECT id FROM giftCodes WHERE id = ?`, [unused.id]), undefined);

  const used = await gifts.createGiftCode({ code: "USED1", grantKind: "credit", creditNanoUsd: USD(1), durationDays: 1, maxRedemptions: 5 });
  const res = db.transaction(() => gifts.redeemGiftCode(db, { userId: "u1", code: "USED1" }));
  assert.deepEqual(await gifts.deleteGiftCode(used.id), { deleted: "soft" });
  assert.equal(await gifts.getGiftCodeById(used.id), null);
  assert.ok(!(await gifts.listGiftCodes()).some((c) => c.id === used.id), "hidden from the list");
  assert.equal((await gifts.listRedemptions(used.id)).length, 1, "history kept");
  assert.ok(db.get(`SELECT id FROM userPlans WHERE id = ?`, [res.userPlan.id]), "the granted purchase stays");
  assert.equal(await gifts.updateGiftCode(used.id, { isActive: true }), null, "a deleted code cannot be revived");
  assert.equal(await gifts.deleteGiftCode(used.id), null);

  await assert.rejects(
    gifts.createGiftCode({ code: "USED1", grantKind: "credit", creditNanoUsd: USD(1), durationDays: 1 }),
    /mã đã xóa/
  );
});

test("a deleted code cannot be assigned", async () => {
  const used = await gifts.createGiftCode({ code: "ASSIGNME", grantKind: "credit", creditNanoUsd: USD(1), durationDays: 1, maxRedemptions: 5 });
  db.transaction(() => gifts.redeemGiftCode(db, { userId: "u1", code: "ASSIGNME" }));
  await gifts.deleteGiftCode(used.id);
  assert.deepEqual(db.transaction(() => gifts.assignGiftCodeSync(db, used.id, { userIds: ["u1"] })), { ok: false, reason: "not_found" });
});

test("an unlimited-plan gift cannot remove every bound", async () => {
  const p = await plan({ unlimitedCredit: true, creditNanoUsd: 0, rpm: 30 });
  await assert.rejects(gifts.createGiftCode({ code: "NOBOUND1", planId: p.id, rpm: 0, tpm: 0 }), /ít nhất một hạn mức/);
  const ok = await gifts.createGiftCode({ code: "BOUND1", planId: p.id, rpm: 0, tpm: 5000 });
  await assert.rejects(gifts.updateGiftCode(ok.id, { tpm: 0 }), /ít nhất một hạn mức/);
  // A plan that loses its bound after the code was saved: redemption is refused.
  const loose = await gifts.createGiftCode({ code: "BOUND2", planId: p.id, rpm: "", tpm: "" });
  db.run(`UPDATE plans SET rpm = NULL WHERE id = ?`, [p.id]);
  assert.equal(db.transaction(() => gifts.redeemGiftCode(db, { userId: "u1", code: "BOUND2" })).reason, "invalid_plan");
  assert.ok(loose);
});

test("renaming or creating onto a deleted code's string names the clash", async () => {
  const used = await gifts.createGiftCode({ code: "GONECODE", grantKind: "credit", creditNanoUsd: USD(1), durationDays: 1, maxRedemptions: 2 });
  db.transaction(() => gifts.redeemGiftCode(db, { userId: "u1", code: "GONECODE" }));
  await gifts.deleteGiftCode(used.id);
  const other = await gifts.createGiftCode({ code: "LIVECODE", grantKind: "credit", creditNanoUsd: USD(1), durationDays: 1 });
  await assert.rejects(gifts.updateGiftCode(other.id, { code: "GONECODE" }), /mã đã xóa/);
  await assert.rejects(gifts.createGiftCode({ code: "GONECODE", grantKind: "credit", creditNanoUsd: USD(1), durationDays: 1 }), /mã đã xóa/);
  await assert.rejects(gifts.createGiftCode({ grantKind: "credit", creditNanoUsd: USD(1), durationDays: 1, rpm: "0x10" }), /RPM/);
  assert.equal(setPurchaseRatesSync(db, "u1", "x", { rpm: true, reason: "bad input" }).status, 404, "unknown purchase checked first");
});

test("a note edit keeps a top-up amount whose plan stopped selling custom amounts", async () => {
  const topup = await plan({ allowCustomAmount: true, priceVnd: 100000, creditNanoUsd: USD(4), customMinVnd: 10000, customMaxVnd: 1000000 });
  const g = await gifts.createGiftCode({ code: "TOPUP1", planId: topup.id, amountVnd: 50000 });
  db.run(`UPDATE plans SET allowCustomAmount = 0 WHERE id = ?`, [topup.id]);
  const edited = await gifts.updateGiftCode(g.id, { note: "just a note", planId: topup.id, amountVnd: 50000 });
  assert.equal(edited.note, "just a note");
  assert.equal(edited.amountVnd, 50000);
});

test("the pin picker shows each plan's effective rate", async () => {
  const { listBindablePlansSync } = await import("../src/lib/db/repos/accountPlansRepo.js");
  const p = await plan({ rpm: 60 });
  const up = grantPlanSync(db, "u1", { planId: p.id, reason: "test" }).userPlan;
  setPurchaseRatesSync(db, "u1", up.id, { rpm: 600, reason: "vip" });
  assert.deepEqual(listBindablePlansSync(db, "u1").map((r) => [r.id, r.rpm]), [[p.id, 600]]);
});
