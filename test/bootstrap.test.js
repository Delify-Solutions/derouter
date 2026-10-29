// Start-up post-sync tasks (design D10 steps 1–3, tasks 2.4/2.5).
//
// The four outcomes the task calls for:
//   1. a fresh DATA_DIR boots with a `Mặc định` group and `defaultUserGroupId` set;
//   2. a user with `groupId = NULL` gets the default group plus a
//      `group_auto_assigned` audit row;
//   3. customer keys lose their key-level limit columns;
//   4. a second boot changes nothing.
//
// Rows are seeded with direct SQL and `runPostSyncTasksSync(db)` is called directly
// (the driver wiring through initAdapter is what makes the first boot happen, and
// the fresh-DB assertions below run against exactly that path).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-bootstrap-test-"));
process.env.DATA_DIR = tmpDir;

// Importing the driver runs migrations AND the bootstrap, so the DB this test gets
// is a genuinely-fresh install that already booted once.
const { getAdapter } = await import("../src/lib/db/driver.js");
const { runPostSyncTasksSync, ensureCustomerGroupsSync } = await import("../src/lib/billing/bootstrap.js");
const { getMetaSync, setMetaSync } = await import("../src/lib/db/helpers/metaStore.js");

let db;
const NOW = () => new Date().toISOString();

before(async () => { db = await getAdapter(); });

after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function wipe() {
  for (const table of [
    "userAuditLog",
    "apiKeys",
    "users",
    "keyGroups",
    "orders",
    "plans",
    "settings",
  ]) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* partial schema */ }
  }
  for (const marker of ["bootstrap.customerKeys.v1", "bootstrap.adminKeyGroups.v1", "bootstrap.orderEmails.v1", "bootstrap.backfill.v1"]) {
    db.run(`DELETE FROM _meta WHERE key = ?`, [marker]);
  }
}

function insertUser(id, { email = `${id}@test.local`, groupId = null } = {}) {
  db.run(
    `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
     VALUES(?, ?, 'x', NULL, ?, 'active', 0, ?, ?)`,
    [id, email, groupId, NOW(), NOW()]
  );
}

function activeGroups() {
  return db.all(`SELECT * FROM keyGroups WHERE isActive = 1 ORDER BY createdAt ASC, rowid ASC`);
}

function rawSettings() {
  const row = db.get(`SELECT data FROM settings WHERE id = 1`);
  return row ? JSON.parse(row.data) : {};
}

test("a fresh install has an active default group (first boot already ran it)", () => {
  // The driver import above booted this empty directory once.
  const groups = activeGroups();
  assert.ok(groups.length >= 1, "at least one active group exists after the first boot");
  const named = groups.find((group) => group.name === "Mặc định");
  assert.ok(named, "a group named Mặc định was seeded");
  assert.equal(named.rpm, null);
  assert.equal(named.tpm, null);
  assert.equal(named.budgetUsd, null);
  assert.equal(named.allowedModels, null);
  assert.equal(rawSettings().defaultUserGroupId, named.id);
});

test("an ungrouped legacy user is repaired with one audit entry", () => {
  wipe();
  insertUser("u1", { email: "legacy@test.local", groupId: null });

  runPostSyncTasksSync(db);

  const groups = activeGroups();
  assert.ok(groups.length >= 1);
  const user = db.get(`SELECT groupId FROM users WHERE id = 'u1'`);
  assert.equal(user.groupId, groups[0].id);

  const audits = db.all(`SELECT * FROM userAuditLog WHERE userId = 'u1'`);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "group_auto_assigned");
  assert.equal(audits[0].actor, "system");
  const details = JSON.parse(audits[0].details);
  assert.equal(details.before, null);
  assert.equal(details.after, groups[0].id);
});

test("a user pointing at an inactive group is moved to the default", () => {
  wipe();
  db.run(
    `INSERT INTO keyGroups(id, name, isActive, createdAt, updatedAt) VALUES('old', 'Old', 0, ?, ?)`,
    [NOW(), NOW()]
  );
  insertUser("u2", { email: "stale@test.local", groupId: "old" });

  runPostSyncTasksSync(db);

  const groups = activeGroups();
  assert.equal(groups.length, 1, "the seeded default is the only active group");
  const user = db.get(`SELECT groupId FROM users WHERE id = 'u2'`);
  assert.equal(user.groupId, groups[0].id);
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM userAuditLog WHERE action = 'group_auto_assigned'`)?.n, 1);
});

test("customer keys lose their key-level limits, admin keys keep theirs (but not a group)", () => {
  wipe();
  db.run(
    `INSERT INTO keyGroups(id, name, isActive, createdAt, updatedAt) VALUES('g1', 'G', 1, ?, ?)`,
    [NOW(), NOW()]
  );
  insertUser("u1", { groupId: "g1" });

  // A customer key with every limit column set from an earlier admin edit.
  db.run(
    `INSERT INTO apiKeys(id, key, name, isActive, createdAt, groupId, rpm, tpm, budgetUsd, resetWindow, allowedModels, userId)
     VALUES('ck', 'cust-secret', 'cust', 1, ?, 'g1', 1, 2, 3, 'day', '["a"]', 'u1')`,
    [NOW()]
  );
  // An admin key, which must keep its values.
  db.run(
    `INSERT INTO apiKeys(id, key, name, isActive, createdAt, groupId, rpm, tpm, budgetUsd, resetWindow, allowedModels, userId)
     VALUES('ak', 'admin-secret', 'admin', 1, ?, 'g1', 9, 99, 9.5, 'week', '["b"]', NULL)`,
    [NOW()]
  );

  runPostSyncTasksSync(db);

  const customer = db.get(`SELECT * FROM apiKeys WHERE id = 'ck'`);
  assert.equal(customer.groupId, null);
  assert.equal(customer.rpm, null);
  assert.equal(customer.tpm, null);
  assert.equal(customer.budgetUsd, null);
  assert.equal(customer.resetWindow, null);
  assert.equal(customer.allowedModels, null);

  const admin = db.get(`SELECT * FROM apiKeys WHERE id = 'ak'`);
  assert.equal(admin.rpm, 9);
  assert.equal(admin.budgetUsd, 9.5);
  assert.equal(admin.allowedModels, '["b"]');
  assert.equal(admin.groupId, null, "an admin key no longer belongs to a group");
});

test("an admin key inherits its group's model list before losing the group", () => {
  wipe();
  db.run(
    `INSERT INTO keyGroups(id, name, isActive, allowedModels, createdAt, updatedAt) VALUES('g1', 'G', 1, '["glm-5","kimi"]', ?, ?)`,
    [NOW(), NOW()]
  );
  // Inherits the group's list: must keep that restriction as its own.
  db.run(
    `INSERT INTO apiKeys(id, key, name, isActive, createdAt, groupId, allowedModels, userId)
     VALUES('inherits', 'k-inherits', 'a', 1, ?, 'g1', NULL, NULL)`, [NOW()]
  );
  // Has its own list: kept as is.
  db.run(
    `INSERT INTO apiKeys(id, key, name, isActive, createdAt, groupId, allowedModels, userId)
     VALUES('own', 'k-own', 'b', 1, ?, 'g1', '["glm-5"]', NULL)`, [NOW()]
  );
  // Group without a list: the key stays unrestricted.
  db.run(`INSERT INTO keyGroups(id, name, isActive, createdAt, updatedAt) VALUES('g2', 'Open', 1, ?, ?)`, [NOW(), NOW()]);
  db.run(
    `INSERT INTO apiKeys(id, key, name, isActive, createdAt, groupId, allowedModels, userId)
     VALUES('open', 'k-open', 'c', 1, ?, 'g2', NULL, NULL)`, [NOW()]
  );

  runPostSyncTasksSync(db);

  const row = (id) => db.get(`SELECT groupId, allowedModels FROM apiKeys WHERE id = ?`, [id]);
  assert.deepEqual(row("inherits"), { groupId: null, allowedModels: '["glm-5","kimi"]' });
  assert.deepEqual(row("own"), { groupId: null, allowedModels: '["glm-5"]' });
  assert.deepEqual(row("open"), { groupId: null, allowedModels: null });
});

test("orders get an email snapshot from the buyer", () => {
  wipe();
  insertUser("u1", { email: "buyer@test.local", groupId: null });
  db.run(
    `INSERT INTO plans(id, code, name, priceNanoUsd, creditNanoUsd, durationDays, isActive, createdAt, updatedAt)
     VALUES('p1', 'go', 'Go', 10000000000, 250000000000, 30, 1, ?, ?)`,
    [NOW(), NOW()]
  );
  db.run(
    `INSERT INTO orders(id, userId, planId, amountNanoUsd, creditNanoUsd, durationDays, status, createdAt)
     VALUES('o1', 'u1', 'p1', 10000000000, 250000000000, 30, 'paid', ?)`,
    [NOW()]
  );

  runPostSyncTasksSync(db);

  assert.equal(db.get(`SELECT emailSnapshot FROM orders WHERE id = 'o1'`).emailSnapshot, "buyer@test.local");
});

test("a second run changes nothing", () => {
  wipe();
  db.run(
    `INSERT INTO keyGroups(id, name, isActive, createdAt, updatedAt) VALUES('g1', 'G', 1, ?, ?)`,
    [NOW(), NOW()]
  );
  insertUser("u1", { groupId: null });
  insertUser("u2", { groupId: "g1" });
  db.run(
    `INSERT INTO apiKeys(id, key, name, isActive, createdAt, rpm, userId) VALUES('ck', 's', 'c', 1, ?, 5, 'u1')`,
    [NOW()]
  );

  const first = runPostSyncTasksSync(db);
  assert.deepEqual(first.ran.sort(), ["adminKeyGroups", "backfill", "customerKeys", "orderEmails"]);

  const snapshot = () => ({
    groups: db.all(`SELECT * FROM keyGroups ORDER BY id`),
    users: db.all(`SELECT id, groupId FROM users ORDER BY id`),
    keys: db.all(`SELECT id, groupId, rpm FROM apiKeys ORDER BY id`),
    audits: db.all(`SELECT * FROM userAuditLog ORDER BY id`),
    markers: ["bootstrap.customerKeys.v1", "bootstrap.adminKeyGroups.v1", "bootstrap.orderEmails.v1", "bootstrap.backfill.v1"].map((k) => getMetaSync(db, k, null)),
    settings: rawSettings(),
  });

  const beforeSecond = snapshot();
  const second = runPostSyncTasksSync(db);
  assert.deepEqual(second.ran, [], "no one-time task runs twice");
  assert.deepEqual(snapshot(), beforeSecond);
});

test("a failing one-time task does not throw and leaves its marker unset", () => {
  wipe();
  // Make the step eligible to run, then remove the table its UPDATE reads so the
  // task throws inside its own transaction.
  db.run(`DELETE FROM _meta WHERE key = 'bootstrap.orderEmails.v1'`);
  db.exec(`ALTER TABLE orders RENAME TO orders_tmp`);
  try {
    const result = runPostSyncTasksSync(db);
    // The function must return normally; the task just did not run.
    assert.ok(result && Array.isArray(result.ran));
    assert.equal(result.ran.includes("orderEmails"), false);
    assert.equal(getMetaSync(db, "bootstrap.orderEmails.v1", null), null);
  } finally {
    db.exec(`ALTER TABLE orders_tmp RENAME TO orders`);
  }
});

test("ensureCustomerGroupsSync repairs a settings value that names an inactive group", () => {
  wipe();
  db.run(
    `INSERT INTO keyGroups(id, name, isActive, createdAt, updatedAt) VALUES('dead', 'Dead', 0, ?, ?)`,
    [NOW(), NOW()]
  );
  db.run(
    `INSERT INTO keyGroups(id, name, isActive, createdAt, updatedAt) VALUES('live', 'Live', 1, ?, ?)`,
    [NOW(), NOW()]
  );
  db.run(
    `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
    [JSON.stringify({ defaultUserGroupId: "dead" })]
  );

  const result = ensureCustomerGroupsSync(db);
  assert.equal(result.defaultGroupId, "live");
  assert.equal(rawSettings().defaultUserGroupId, "live");
});
