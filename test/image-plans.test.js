// Image plans: a purchase that sells a COUNT of images instead of credit.
//
// These pin the behaviour a customer would notice:
//   * an image plan stores images, not dollars, and never leaks into the credit
//     balance (or the reverse);
//   * an image request is paid in images by an image purchase and only falls back
//     to credit — charged at the per-image price — when no image purchase can pay;
//   * a text request can never spend an image plan;
//   * image windows count images and block on their own unit;
//   * expiry/refund take images back without inventing a dollar movement.
//
// Everything runs against a throwaway SQLite DB and every function under test is
// synchronous and takes the adapter, so `now` is always explicit.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-image-plans-test-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const queue = await import("../src/lib/billing/planQueue.js");
const { grantUserPlan } = await import("../src/lib/billing/grants.js");
const { NANO } = await import("../src/shared/utils/money.js");
const billing = await import("../src/lib/db/repos/billingRepo.js");
const admin = await import("../src/lib/billing/adminActions.js");
const { validateLimits, describeLimit, normalizeLimits } = await import("../src/lib/billing/limits.js");
const accountPlans = await import("../src/lib/db/repos/accountPlansRepo.js");

let db;

const USD = (n) => Math.round(n * NANO);
const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 1, 9, 0, 0);
const at = (ms) => new Date(ms).toISOString();

before(async () => { db = await getAdapter(); });

after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  for (const table of [
    "userPlanWindows", "creditLedger", "userPlans", "orders", "plans",
    "giftRedemptions", "giftCodes", "apiKeys", "users", "usageHistory", "kv", "userAuditLog",
  ]) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* partial schema */ }
  }
  db.run(`INSERT INTO users(id, email, passwordHash, status, createdAt) VALUES('u1','a@b.c','x','active',?)`, [at(T0)]);
});

/** Grant one purchase directly, bypassing the plan template (the engine's contract). */
function grant({ kind = "llm", planId = null, credit = 0, images = 0, hours = 720, limits = [], source = "admin", now = at(T0) } = {}) {
  return db.transaction(() => grantUserPlan(db, {
    userId: "u1",
    planId,
    orderId: null,
    source,
    kind,
    creditNanoUsd: credit,
    imageCount: images,
    durationDays: hours / 24,
    limits,
    now,
  }));
}

const row = (id) => db.get(`SELECT * FROM userPlans WHERE id = ?`, [id]);

// ── Storage ────────────────────────────────────────────────────────────────

test("an image grant stores images and never touches the credit columns", () => {
  const { userPlan } = grant({ kind: "image", images: 50 });
  const stored = row(userPlan.id);
  assert.equal(stored.kind, "image");
  assert.equal(stored.imageTotal, 50);
  assert.equal(stored.imageRemaining, 50);
  assert.equal(stored.creditTotalNanoUsd, 0, "an image plan sells no credit");
  assert.equal(stored.creditRemainingNanoUsd, 0);
});

test("a credit grant keeps maxImages absent and stores credit as before", () => {
  const { userPlan } = grant({ credit: USD(10) });
  const stored = row(userPlan.id);
  assert.equal(stored.kind, "llm");
  assert.equal(stored.imageTotal, 0);
  assert.equal(stored.creditRemainingNanoUsd, USD(10));
});

test("an image grant records the movement in images, not dollars", () => {
  const { userPlan } = grant({ kind: "image", images: 30 });
  const ledger = db.get(`SELECT * FROM creditLedger WHERE userPlanId = ? AND kind = 'grant'`, [userPlan.id]);
  assert.equal(ledger.deltaImages, 30);
  assert.equal(ledger.deltaNanoUsd, 0, "no dollar movement for images");
  assert.equal(ledger.balanceAfterImages, 30);
});

// ── Admission ──────────────────────────────────────────────────────────────

test("a text request can never be paid by an image purchase", () => {
  grant({ kind: "image", images: 10 });
  const denied = queue.admitSync(db, "u1", at(T0 + 1000));
  assert.equal(denied.ok, false, "no credit purchase exists");
  assert.equal(denied.status, 402);
});

test("an image request is admitted by an image purchase", () => {
  const { userPlan } = grant({ kind: "image", images: 10 });
  const admitted = queue.admitSync(db, "u1", at(T0 + 1000), { requestKind: "image" });
  assert.equal(admitted.ok, true);
  assert.equal(admitted.planId, userPlan.id);
  assert.equal(admitted.kind, "image");
});

test("an image request prefers an image purchase over an earlier credit purchase", () => {
  const credit = grant({ credit: USD(50) });
  const images = grant({ kind: "image", images: 5 });
  // The credit purchase is first in the queue, but the image purchase is the one
  // the images were sold for.
  assert.equal(queue.admitSync(db, "u1", at(T0 + 1000)).planId, credit.userPlan.id);
  assert.equal(
    queue.admitSync(db, "u1", at(T0 + 1000), { requestKind: "image" }).planId,
    images.userPlan.id
  );
});

test("an image request falls back to a credit purchase when no image purchase can pay", () => {
  const credit = grant({ credit: USD(50) });
  grant({ kind: "image", images: 0 });
  const admitted = queue.admitSync(db, "u1", at(T0 + 1000), { requestKind: "image" });
  assert.equal(admitted.ok, true);
  assert.equal(admitted.planId, credit.userPlan.id);
  assert.equal(admitted.kind, "llm");
});

// ── Charging ───────────────────────────────────────────────────────────────

test("an image is charged as one image, with no dollar cost against the purchase", () => {
  const { userPlan } = grant({ kind: "image", images: 3 });
  const res = db.transaction(() => queue.chargeSync(db, {
    userId: "u1",
    requestKey: "r1",
    imageCount: 2,
    costNanoUsd: USD(0.08),
    nowIso: at(T0 + 1000),
  }));

  assert.equal(row(userPlan.id).imageRemaining, 1);
  const charge = db.get(`SELECT * FROM creditLedger WHERE kind = 'charge' AND userPlanId = ?`, [userPlan.id]);
  assert.equal(charge.deltaImages, -2);
  assert.equal(charge.deltaNanoUsd, 0, "an image purchase never pays dollars");
  assert.equal(res.parts.length, 1);
  assert.equal(res.parts[0].images, 2);
});

test("images are covered by the image purchase, so no debt arises from the dollar cost", () => {
  grant({ kind: "image", images: 1 });
  const res = db.transaction(() => queue.chargeSync(db, {
    userId: "u1",
    requestKey: "r1",
    imageCount: 1,
    costNanoUsd: USD(0.04),
    nowIso: at(T0 + 1000),
  }));
  assert.equal(res.debtNanoUsd, 0, "the image paid for itself; the list price is not owed");
  // No overdraft ledger row: `"overdraft":true` is the marker a debt charge writes,
  // and the grant row's `appliedToOverdraftNanoUsd` field must not be counted here.
  assert.equal(
    db.get(`SELECT COUNT(*) AS n FROM creditLedger WHERE meta LIKE '%"overdraft":true%'`).n,
    0
  );
});

test("an image request with no image purchase charges the per-image price to credit", () => {
  const { userPlan } = grant({ credit: USD(10) });
  db.transaction(() => queue.chargeSync(db, {
    userId: "u1",
    requestKey: "r1",
    imageCount: 1,
    costNanoUsd: USD(0.05),
    nowIso: at(T0 + 1000),
  }));
  assert.equal(row(userPlan.id).creditRemainingNanoUsd, USD(10) - USD(0.05));
});

test("a purchase is exhausted exactly when its last image is spent", () => {
  const { userPlan } = grant({ kind: "image", images: 2 });
  db.transaction(() => queue.chargeSync(db, {
    userId: "u1", requestKey: "r1", imageCount: 2, costNanoUsd: 0, nowIso: at(T0 + 1000),
  }));
  const stored = row(userPlan.id);
  assert.equal(stored.imageRemaining, 0);
  assert.equal(stored.status, "exhausted");
  assert.equal(queue.admitSync(db, "u1", at(T0 + 2000), { requestKind: "image" }).status, 402);
});

test("charging the same image request twice writes nothing the second time", () => {
  const { userPlan } = grant({ kind: "image", images: 5 });
  const args = { userId: "u1", requestKey: "r1", imageCount: 2, costNanoUsd: 0, nowIso: at(T0 + 1000) };
  db.transaction(() => queue.chargeSync(db, args));
  const second = db.transaction(() => queue.chargeSync(db, args));
  assert.equal(second.alreadyCharged, true);
  assert.equal(row(userPlan.id).imageRemaining, 3);
});

// ── Windows ────────────────────────────────────────────────────────────────

test("an image window counts images and blocks the purchase when full", () => {
  const { userPlan } = grant({ kind: "image", images: 100, limits: [{ hours: 5, maxNanoUsd: 0, maxImages: 20 }] });
  db.transaction(() => queue.chargeSync(db, {
    userId: "u1", requestKey: "r1", imageCount: 20, costNanoUsd: 0, nowIso: at(T0 + 1000),
  }));

  const [entry] = queue.listQueueSync(db, "u1", at(T0 + 2000));
  const state = queue.evaluatePlan(entry, T0 + 2000);
  assert.equal(state.blocked, true);
  assert.equal(state.windows[0].spentImages, 20);
  assert.equal(state.windows[0].maxImages, 20);
  assert.equal(state.windows[0].spentNanoUsd, 0, "an image window never accumulates dollars");
  assert.equal(
    queue.admitSync(db, "u1", at(T0 + 2000), { requestKind: "image" }).status,
    429
  );
  // Reopens after the 5-hour window closes.
  assert.equal(
    queue.admitSync(db, "u1", at(T0 + 5 * HOUR + 60_000), { requestKind: "image" }).ok,
    true
  );
  assert.equal(row(userPlan.id).imageRemaining, 80, "images not blocked by the window are kept");
});

test("the window counters can be rebuilt from the ledger in the image unit", () => {
  const { userPlan } = grant({ kind: "image", images: 100, limits: [{ hours: 5, maxNanoUsd: 0, maxImages: 50 }] });
  db.transaction(() => queue.chargeSync(db, {
    userId: "u1", requestKey: "r1", imageCount: 7, costNanoUsd: 0, nowIso: at(T0 + 1000),
  }));

  const rebuilt = queue.rebuildWindowsSync(db, userPlan.id, at(T0 + 2000));
  assert.equal(rebuilt[5].spentImages, 7);
  assert.equal(rebuilt[5].spentNanoUsd, 0);
});

// ── Expiry, revoke, refund ─────────────────────────────────────────────────

test("expiring an image purchase forfeits images without moving dollars", () => {
  const { userPlan } = grant({ kind: "image", images: 12, now: at(T0) });
  db.transaction(() => billing.expireStalePlans(db, at(T0 + 40 * 24 * HOUR)));

  const stored = row(userPlan.id);
  assert.equal(stored.status, "expired");
  assert.equal(stored.imageRemaining, 0);
  const expire = db.get(`SELECT * FROM creditLedger WHERE userPlanId = ? AND kind = 'expire'`, [userPlan.id]);
  assert.equal(expire.deltaImages, -12);
  assert.equal(expire.deltaNanoUsd, 0);
});

test("revoking an image purchase takes the images back and keeps the audit trail", () => {
  const { userPlan } = grant({ kind: "image", images: 9 });
  const res = db.transaction(() => admin.revokePlanSync(db, "u1", userPlan.id, { reason: "khách báo lỗi" }));
  assert.equal(res.ok, true);
  assert.equal(res.revokedImages, 9);
  assert.equal(res.revokedNanoUsd, 0);
  assert.equal(row(userPlan.id).imageRemaining, 0);
  assert.equal(row(userPlan.id).status, "revoked");
});

test("the admin grant of an image plan hands out its image count", () => {
  db.run(
    `INSERT INTO plans(id, code, name, priceNanoUsd, creditNanoUsd, kind, imageCount, durationDays, isActive, createdAt)
     VALUES('p-img', 'img-100', 'Image 100', ?, 0, 'image', 100, 30, 1, ?)`,
    [USD(10), at(T0)]
  );
  const res = db.transaction(() => admin.grantPlanSync(db, "u1", { planId: "p-img", reason: "tặng khách" }));
  assert.equal(res.ok, true);
  assert.equal(res.userPlan.imageTotal, 100);
  assert.equal(res.userPlan.creditTotalNanoUsd, 0);
  assert.equal(res.userPlan.kind, "image");
});

// ── Validation ─────────────────────────────────────────────────────────────

test("image limits are validated in images, not dollars", () => {
  assert.equal(
    validateLimits([{ hours: 5, maxNanoUsd: 0, maxImages: 20 }], { kind: "image", imageTotal: 100, durationDays: 30 }),
    null
  );
  // A ceiling at or above the plan's own count is refused: it would never bind.
  assert.match(
    validateLimits([{ hours: 5, maxNanoUsd: 0, maxImages: 100 }], { kind: "image", imageTotal: 100, durationDays: 30 }),
    /phải nhỏ hơn số ảnh/
  );
  // Monotonic in window length, in the image unit.
  assert.match(
    validateLimits(
      [{ hours: 5, maxNanoUsd: 0, maxImages: 40 }, { hours: 24, maxNanoUsd: 0, maxImages: 10 }],
      { kind: "image", imageTotal: 100, durationDays: 30 }
    ),
    /không được lớn hơn/
  );
});

test("an image limit reads in images and a credit limit reads in dollars", () => {
  assert.equal(describeLimit({ hours: 5, maxNanoUsd: 0, maxImages: 20 }), "Tối đa 20 ảnh mỗi 5 giờ");
  assert.equal(describeLimit({ hours: 5, maxNanoUsd: USD(20) }), "Tối đa $20 mỗi 5 giờ");
});

test("a credit limit serialises byte-identically to what earlier versions wrote", () => {
  assert.deepEqual(normalizeLimits([{ hours: 5, maxNanoUsd: USD(20) }]), [
    { hours: 5, maxNanoUsd: USD(20) },
  ]);
});

test("an image plan needs a positive whole image count and cannot be unlimited or topped up", () => {
  const base = {
    code: "imgp",
    name: "Image",
    priceNanoUsd: USD(10),
    kind: "image",
    durationDays: 30,
  };
  assert.match(billing.validatePlanInput({ ...base, imageCount: 0 }), /số ảnh/);
  assert.match(billing.validatePlanInput({ ...base, imageCount: 2.5 }), /số ảnh/);
  assert.match(
    billing.validatePlanInput({ ...base, imageCount: 50, unlimitedCredit: true }),
    /không dùng credit không giới hạn/
  );
  assert.match(
    billing.validatePlanInput({ ...base, imageCount: 50, allowCustomAmount: true, priceVnd: 250000 }),
    /không nạp số tiền tùy ý/
  );
  assert.equal(billing.validatePlanInput({ ...base, imageCount: 50 }), null);
});

// ── Plan CRUD ──────────────────────────────────────────────────────────────

test("a created image plan stores the count and keeps credit at zero", async () => {
  const plan = await billing.createPlan({
    code: "img100",
    name: "100 ảnh",
    priceNanoUsd: USD(10),
    creditNanoUsd: USD(999),
    kind: "image",
    imageCount: 100,
    durationDays: 30,
  });
  assert.equal(plan.kind, "image");
  assert.equal(plan.imageCount, 100);
  assert.equal(plan.creditNanoUsd, 0, "the credit sent with an image plan is ignored");
  assert.equal(plan.unlimitedCredit, false);
});

test("switching a plan to image drops its credit, and back again drops its count", async () => {
  const plan = await billing.createPlan({
    code: "switch", name: "Switch", priceNanoUsd: USD(5), creditNanoUsd: USD(50), durationDays: 30,
  });
  assert.equal(plan.kind, "llm");

  const asImage = await billing.updatePlan(plan.id, { kind: "image", imageCount: 20, creditNanoUsd: 0 });
  assert.equal(asImage.imageCount, 20);
  assert.equal(asImage.creditNanoUsd, 0);

  const back = await billing.updatePlan(plan.id, { kind: "llm", creditNanoUsd: USD(50) });
  assert.equal(back.kind, "llm");
  assert.equal(back.imageCount, 0, "an llm plan keeps no image count");
  assert.equal(back.creditNanoUsd, USD(50));
});

// ── Surfaces ───────────────────────────────────────────────────────────────

test("the ledger payload carries image movements beside the money ones", () => {
  const { userPlan } = grant({ kind: "image", images: 100 });
  db.transaction(() => queue.chargeSync(db, {
    userId: "u1", requestKey: "r1", imageCount: 2, costNanoUsd: 0, nowIso: at(T0 + 1000),
  }));

  const ledger = accountPlans.getAccountLedgerSync(db, "u1", { pageSize: 25, page: 1 });
  const imageRows = ledger.entries.filter((entry) => entry.deltaImages !== 0);
  const charge = imageRows.find((entry) => entry.kind === "charge");

  assert.equal(imageRows.length, 2, "one grant and one charge move images");
  assert.equal(charge.deltaImages, -2);
  assert.equal(charge.deltaNanoUsd, 0);
  assert.equal(charge.balanceAfterImages, 98);
  // A credit-plan row must not look like an image row: same payload, zero images.
  grant({ credit: USD(5) });
  const creditRow = accountPlans.getAccountLedgerSync(db, "u1", { pageSize: 25, page: 1 })
    .entries.find((entry) => entry.kind === "grant" && entry.deltaNanoUsd > 0);
  assert.equal(creditRow.deltaImages, 0);
  assert.equal(creditRow.deltaNanoUsd, USD(5));
});

test("the queue payload exposes the image balance and per-window image counts", () => {
  grant({ kind: "image", images: 100, limits: [{ hours: 5, maxNanoUsd: 0, maxImages: 20 }] });
  db.transaction(() => queue.chargeSync(db, {
    userId: "u1", requestKey: "r1", imageCount: 3, costNanoUsd: 0, nowIso: at(T0 + 1000),
  }));

  const [entry] = accountPlans.getQueueSync(db, "u1", at(T0 + 2000));
  assert.equal(entry.kind, "image");
  assert.equal(entry.imageTotal, 100);
  assert.equal(entry.imageRemaining, 97);
  assert.equal(entry.creditRemainingNanoUsd, 0);
  assert.equal(entry.windows[0].maxImages, 20);
  assert.equal(entry.windows[0].spentImages, 3);
  assert.equal(entry.windows[0].spentNanoUsd, 0);
});

test("the plan history carries kind and both balances for the inactive tab", () => {
  const { userPlan } = grant({ kind: "image", images: 9 });
  db.transaction(() => billing.expireStalePlans(db, at(T0 + 40 * 24 * HOUR)));

  const [row] = accountPlans.getPlanHistorySync(db, "u1");
  assert.equal(row.id, userPlan.id);
  assert.equal(row.kind, "image");
  assert.equal(row.imageTotal, 9);
  assert.equal(row.imageRemaining, 0);
  assert.equal(row.status, "expired");
});
