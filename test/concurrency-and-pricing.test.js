// Billing gaps closed after the security review:
//   * a parallel burst admitted on the same credit (per-account concurrency cap);
//   * customer requests for a model with no token price (billed $0);
//   * a dated model id priced by a cheaper glob instead of its undated price.
// Relative imports only: plain `node --test` cannot resolve the `@/` alias.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-concurrency-test-"));
process.env.DATA_DIR = tmpDir;
process.env.TPM_MAX_WAIT_MS = "0";
process.env.CUSTOMER_MAX_CONCURRENT_REQUESTS = "2";

const { getAdapter } = await import("../src/lib/db/driver.js");
const inflight = await import("../src/lib/billing/inflight.js");
const { enforceKeyLimits } = await import("../src/lib/auth/keyEnforcement.js");
const { refuseUnpricedModel, hasTokenPrice } = await import("../src/lib/billing/unpricedModels.js");
const { resolvePrice, updatePricing } = await import("../src/lib/db/repos/pricingRepo.js");
const { NANO } = await import("../src/shared/utils/money.js");

let db;
const USD = (n) => Math.round(n * NANO);
const NOW = () => new Date().toISOString();
let seq = 0;

before(async () => { db = await getAdapter(); });
after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(() => {
  for (const table of ["usageHistory", "creditLedger", "userPlanWindows", "userPlans", "apiKeys", "users", "keyGroups", "plans"]) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* table may not exist */ }
  }
});

function customer(userId = "u1") {
  const now = NOW();
  db.run(`INSERT OR IGNORE INTO keyGroups(id, name, isActive, createdAt, updatedAt) VALUES('g', 'g', 1, ?, ?)`, [now, now]);
  db.run(
    `INSERT INTO users(id, email, passwordHash, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
     VALUES(?, ?, 'x', 'g', 'active', 0, ?, ?)`,
    [userId, `${userId}@test.local`, now, now]
  );
  db.run(
    `INSERT INTO plans(id, code, name, priceNanoUsd, creditNanoUsd, durationDays, isActive, createdAt, updatedAt)
     VALUES(?, ?, 'P', 0, ?, 30, 1, ?, ?)`,
    [`p-${userId}`, `p-${userId}`, USD(100), now, now]
  );
  db.run(
    `INSERT INTO userPlans(id, userId, planId, orderId, source, creditTotalNanoUsd, creditRemainingNanoUsd, startsAt, expiresAt, status, createdAt)
     VALUES(?, ?, ?, NULL, 'purchase', ?, ?, ?, ?, 'active', ?)`,
    [`up-${userId}`, userId, `p-${userId}`, USD(10), USD(10), now, new Date(Date.now() + 86_400_000 * 30).toISOString(), now]
  );
  seq += 1;
  const secret = `secret-${userId}-${seq}`;
  db.run(`INSERT INTO apiKeys(id, key, name, isActive, createdAt, userId) VALUES(?, ?, 'k', 1, ?, ?)`, [`k-${userId}-${seq}`, secret, now, userId]);
  return secret;
}

function adminKey() {
  seq += 1;
  const secret = `secret-admin-${seq}`;
  db.run(`INSERT INTO apiKeys(id, key, name, isActive, createdAt) VALUES(?, ?, 'adm', 1, ?)`, [`adm-${seq}`, secret, NOW()]);
  return secret;
}

// ── Concurrency cap ────────────────────────────────────────────────────────

test("a customer can run at most N requests at once; finishing one frees a slot", async () => {
  const secret = customer();
  const scopes = [inflight.createRequestScope(), inflight.createRequestScope(), inflight.createRequestScope()];
  const run = (scope) => inflight.runInScope(scope, () => enforceKeyLimits(secret, "m"));

  assert.equal((await run(scopes[0])).ok, true);
  assert.equal((await run(scopes[1])).ok, true);
  const third = await run(scopes[2]);
  assert.equal(third.ok, false);
  assert.equal(third.status, 429);
  assert.equal(third.code, "concurrency_limit");
  assert.match(third.message, /tối đa 2/);

  inflight.releaseScope(scopes[0]);
  assert.equal((await run(inflight.createRequestScope())).ok, true);
  inflight.releaseScope(scopes[1]);
});

test("the cap is per account, and one request holds one slot however many checks it runs", async () => {
  const a = customer("ua");
  const b = customer("ub");
  const scope = inflight.createRequestScope();
  await inflight.runInScope(scope, async () => {
    assert.equal((await enforceKeyLimits(a, "m")).ok, true);
    assert.equal((await enforceKeyLimits(a, "m")).ok, true, "a second check of the same request");
  });
  assert.equal(inflight.inflightCount("ua"), 1);
  const other = inflight.createRequestScope();
  assert.equal((await inflight.runInScope(other, () => enforceKeyLimits(b, "m"))).ok, true);
  inflight.releaseScope(scope);
  inflight.releaseScope(other);
  assert.equal(inflight.inflightCount("ua"), 0);
});

test("admin keys and calls outside a request scope are not capped", async () => {
  const admin = adminKey();
  for (let i = 0; i < 5; i += 1) {
    const scope = inflight.createRequestScope();
    assert.equal((await inflight.runInScope(scope, () => enforceKeyLimits(admin, "m"))).ok, true);
  }
  const secret = customer("unscoped");
  for (let i = 0; i < 5; i += 1) assert.equal((await enforceKeyLimits(secret, "m")).ok, true);
});

test("a slot is released when the response body ends, is cancelled, or the handler throws", async () => {
  const userId = "rel";
  const handler = inflight.withInflightScope(async () => {
    inflight.acquireSlot(userId, { max: 5 });
    return new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode("a")); c.enqueue(new TextEncoder().encode("b")); c.close(); },
    }), { status: 200, headers: { "x-test": "1" } });
  });

  const res = await handler(new Request("http://x/"));
  assert.equal(inflight.inflightCount(userId), 1, "held while the body is unread");
  assert.equal(res.headers.get("x-test"), "1");
  assert.equal(await res.text(), "ab");
  assert.equal(inflight.inflightCount(userId), 0, "released at end of body");

  const res2 = await handler(new Request("http://x/"));
  await res2.body.cancel();
  assert.equal(inflight.inflightCount(userId), 0, "released on client cancel");

  const throwing = inflight.withInflightScope(async () => {
    inflight.acquireSlot(userId, { max: 5 });
    throw new Error("boom");
  });
  await assert.rejects(() => throwing(new Request("http://x/")));
  assert.equal(inflight.inflightCount(userId), 0, "released when the handler throws");
});

test("a nested wrapped handler shares the outer scope", async () => {
  const inner = inflight.withInflightScope(async () => {
    inflight.acquireSlot("nest", { max: 5 });
    return new Response("x");
  });
  const outer = inflight.withInflightScope(async (req) => {
    const r = await inner(req);
    assert.equal(inflight.inflightCount("nest"), 1, "inner does not release on its own");
    return r;
  });
  const res = await outer(new Request("http://x/"));
  await res.text();
  assert.equal(inflight.inflightCount("nest"), 0);
});

test("a leaked slot expires after the lease TTL", () => {
  const scope = inflight.createRequestScope();
  const t0 = Date.now();
  inflight.runInScope(scope, () => inflight.acquireSlot("leak", { max: 1, now: t0 }));
  const blocked = inflight.runInScope(inflight.createRequestScope(), () => inflight.acquireSlot("leak", { max: 1, now: t0 + 1000 }));
  assert.equal(blocked.ok, false);
  const later = inflight.runInScope(inflight.createRequestScope(), () => inflight.acquireSlot("leak", { max: 1, now: t0 + inflight.LEASE_TTL_MS + 1 }));
  assert.equal(later.ok, true);
});

// ── Unpriced models ────────────────────────────────────────────────────────

test("a customer key is refused on a model with no token price", async () => {
  const secret = customer("np");
  const none = async () => ({ pricing: null });
  const zero = async () => ({ pricing: { input: 0, output: 0 } });
  const priced = async () => ({ pricing: { input: 1, output: 2 } });

  const denial = await refuseUnpricedModel(db, { apiKey: secret, provider: "openai", model: "x", resolvePrice: none });
  assert.equal(denial.status, 403);
  assert.equal(denial.code, "model_not_priced");
  assert.match(denial.message, /openai\/x/);
  assert.ok(await refuseUnpricedModel(db, { apiKey: secret, provider: "openai", model: "x", resolvePrice: zero }));
  assert.equal(await refuseUnpricedModel(db, { apiKey: secret, provider: "openai", model: "x", resolvePrice: priced }), null);
  const failing = async () => { throw new Error("lookup broke"); };
  assert.ok(await refuseUnpricedModel(db, { apiKey: secret, provider: "openai", model: "x", resolvePrice: failing }), "a failed lookup refuses");
  const named = await refuseUnpricedModel(db, { apiKey: secret, provider: "openai", model: "x", requestedModel: "my-combo", resolvePrice: none });
  assert.match(named.message, /my-combo/, "the customer sees the name they asked for");
});

test("admin keys and keyless calls are never refused for a missing price", async () => {
  const none = async () => ({ pricing: null });
  assert.equal(await refuseUnpricedModel(db, { apiKey: adminKey(), provider: "p", model: "m", resolvePrice: none }), null);
  assert.equal(await refuseUnpricedModel(db, { apiKey: null, provider: "p", model: "m", resolvePrice: none }), null);
});

test("hasTokenPrice", () => {
  assert.equal(hasTokenPrice(null), false);
  assert.equal(hasTokenPrice({ input: 0, output: 0 }), false);
  assert.equal(hasTokenPrice({ input: "abc" }), false);
  assert.equal(hasTokenPrice({ output: 0.5 }), true);
  assert.equal(hasTokenPrice({ cached: 0.1 }), true);
});

// ── Dated model ids ────────────────────────────────────────────────────────

test("a dated model id is priced like its undated model", async () => {
  await updatePricing({ openai: { "gpt-4o": { input: 2.5, output: 10 } } });
  const { pricing, source } = await resolvePrice({ provider: "openai", model: "gpt-4o-2024-11-20" });
  assert.equal(source, "user");
  assert.deepEqual(pricing, { input: 2.5, output: 10 });
});

test("an exact price for the dated id still wins over the undated one", async () => {
  await updatePricing({ openai: { "gpt-4o": { input: 2.5, output: 10 }, "gpt-4o-2024-05-13": { input: 5, output: 15 } } });
  const { pricing } = await resolvePrice({ provider: "openai", model: "gpt-4o-2024-05-13" });
  assert.deepEqual(pricing, { input: 5, output: 15 });
});
