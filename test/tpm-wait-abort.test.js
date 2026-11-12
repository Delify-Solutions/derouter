// The TPM wait queue (change hardening-wave1): the wait budget starts when a
// request joins the queue, and a client that hangs up leaves it at once.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-tpm-wait-"));
process.env.DATA_DIR = tmpDir;
process.env.TPM_MAX_WAIT_MS = "1500";

const { getAdapter } = await import("../src/lib/db/driver.js");
const { enforceKeyLimits } = await import("../src/lib/auth/keyEnforcement.js");
const { NANO } = await import("../src/shared/utils/money.js");

let db;
const NOW = () => new Date().toISOString();

before(async () => { db = await getAdapter(); });
after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  for (const t of ["usageHistory", "userPlans", "apiKeys", "users", "plans", "keyGroups"]) db.run(`DELETE FROM ${t}`);
  const now = NOW();
  db.run(`INSERT INTO keyGroups(id, name, isActive, createdAt, updatedAt) VALUES('g', 'g', 1, ?, ?)`, [now, now]);
  db.run(
    `INSERT INTO plans(id, code, name, priceNanoUsd, creditNanoUsd, durationDays, isActive, tpm, createdAt, updatedAt)
     VALUES('p', 'p', 'p', 0, ?, 30, 1, 100, ?, ?)`,
    [100 * NANO, now, now]
  );
  db.run(
    `INSERT INTO users(id, email, passwordHash, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
     VALUES('u1', 'u1@test.local', 'x', 'g', 'active', 0, ?, ?)`,
    [now, now]
  );
  db.run(
    `INSERT INTO apiKeys(id, key, name, isActive, createdAt, userId, keyPrefix) VALUES('k1', 'secret-k1', 'k1', 1, ?, 'u1', 'secret-k')`,
    [now]
  );
  db.run(
    `INSERT INTO userPlans(id, userId, planId, source, creditTotalNanoUsd, creditRemainingNanoUsd, startsAt, expiresAt, status, createdAt)
     VALUES('up1', 'u1', 'p', 'purchase', ?, ?, ?, ?, 'active', ?)`,
    [10 * NANO, 10 * NANO, now, new Date(Date.now() + 30 * 86_400_000).toISOString(), now]
  );
  // The minute is already full.
  db.run(
    `INSERT INTO usageHistory(timestamp, provider, model, apiKeyId, promptTokens, completionTokens, costNanoUsd, status, meta, ratePlanId)
     VALUES(?, 'test', 'm', 'k1', 60, 60, 0, 'ok', '{}', 'p')`,
    [now]
  );
});

test("a client that hangs up while waiting for TPM leaves the queue at once, as no denial", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const pending = enforceKeyLimits("secret-k1", "m", { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.clientGone, true, "not a rate-limit denial");
  assert.equal(result.status, 499);
  assert.ok(Date.now() - started < 1000, "did not sit out the wait budget");
});

test("queued requests share one wait budget instead of adding theirs up", async () => {
  const started = Date.now();
  const results = await Promise.all([1, 2, 3].map(() => enforceKeyLimits("secret-k1", "m")));
  const elapsed = Date.now() - started;
  for (const r of results) {
    assert.equal(r.ok, false);
    assert.equal(r.code, "rate_limit");
  }
  assert.ok(elapsed < 2 * 1500, `three queued requests gave up in ${elapsed} ms, not 3 × 1500`);
});

test("a request queued behind another leaves the queue as soon as its client does", async () => {
  const first = enforceKeyLimits("secret-k1", "m"); // holds the per-user queue for the whole budget
  const controller = new AbortController();
  const started = Date.now();
  const queued = enforceKeyLimits("secret-k1", "m", { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  const result = await queued;
  assert.equal(result.clientGone, true);
  assert.ok(Date.now() - started < 1000, "did not wait for its turn");
  assert.equal((await first).code, "rate_limit");
});
