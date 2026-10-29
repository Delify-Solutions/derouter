// Customer-group invariants that a verify pass found broken (C1, C2, N1, N4).
//
// Each case is a way the "every customer has exactly one ACTIVE group" rule could be
// broken through the admin API — the failure mode is severe and silent: zero active
// groups makes every customer key resolve group === null and 403 for everyone until
// the next boot repairs it.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-groupguards-test-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const groups = await import("../src/lib/db/repos/keyGroupsRepo.js");
const { ensureCustomerGroupsSync } = await import("../src/lib/billing/bootstrap.js");

let db;
const now = () => new Date().toISOString();

before(async () => { db = await getAdapter(); });

after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  for (const table of ["users", "keyGroups", "settings", "userAuditLog", "apiKeys"]) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* partial schema */ }
  }
});

function insertGroup(id, { name = id, isActive = 1 } = {}) {
  db.run(
    `INSERT INTO keyGroups(id, name, isActive, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?)`,
    [id, name, isActive, now(), now()]
  );
}

function insertUser(id, groupId = null) {
  db.run(
    `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
     VALUES(?, ?, 'x', NULL, ?, 'active', 0, ?, ?)`,
    [id, `${id}@test.local`, groupId, now(), now()]
  );
}

function setDefault(groupId) {
  db.run(
    `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
    [JSON.stringify({ defaultUserGroupId: groupId })]
  );
}

// ── C1: a non-boolean isActive must not bypass the guard ───────────────────

test("toBool treats only an explicit off value as off", () => {
  assert.equal(groups.toBool(undefined), true, "not provided keeps the group on");
  assert.equal(groups.toBool(true), true);
  assert.equal(groups.toBool(1), true);
  assert.equal(groups.toBool("true"), true);
  assert.equal(groups.toBool("on"), true);
  assert.equal(groups.toBool(false), false);
  assert.equal(groups.toBool(0), false);
  assert.equal(groups.toBool(null), false);
  assert.equal(groups.toBool(""), false);
  assert.equal(groups.toBool("0"), false);
  assert.equal(groups.toBool("false"), false);
  assert.equal(groups.toBool(" OFF "), false);
});

test("C1: {isActive: 0} cannot deactivate the last active group", async () => {
  insertGroup("g1", { name: "Mặc định", isActive: 1 });
  insertUser("u1", "g1");
  setDefault("g1");

  const result = await groups.updateKeyGroup("g1", { isActive: 0 });
  assert.equal(result?.ok, false, "the guard refused");
  assert.ok(result.guard.isLastActive || result.guard.isDefault);
  assert.equal(db.get(`SELECT isActive FROM keyGroups WHERE id = 'g1'`).isActive, 1, "still active");
});

test("C1: string 'false' and null cannot deactivate a group with members", async () => {
  insertGroup("g1", { name: "A", isActive: 1 });
  insertGroup("g2", { name: "B", isActive: 1 });
  insertUser("u1", "g1");
  setDefault("g2");

  for (const value of ["false", "0", null, ""]) {
    const result = await groups.updateKeyGroup("g1", { isActive: value });
    assert.equal(result?.ok, false, `isActive=${JSON.stringify(value)} must be guarded`);
    assert.equal(db.get(`SELECT isActive FROM keyGroups WHERE id = 'g1'`).isActive, 1);
  }
});

test("C1: a real false on an empty non-default group still deactivates", async () => {
  insertGroup("g1", { name: "Default", isActive: 1 });
  insertGroup("g2", { name: "Spare", isActive: 1 });
  setDefault("g1");

  const result = await groups.updateKeyGroup("g2", { isActive: false });
  assert.equal(result?.isActive, false);
  assert.equal(db.get(`SELECT isActive FROM keyGroups WHERE id = 'g2'`).isActive, 0);
});

test("C1: at least one active group always survives", async () => {
  insertGroup("g1", { name: "Only", isActive: 1 });
  setDefault("g1");

  // Every falsy spelling is refused because it is the last active group.
  for (const value of [false, 0, "false", null]) {
    const result = await groups.updateKeyGroup("g1", { isActive: value });
    assert.equal(result?.ok, false);
  }
  const activeCount = Number(db.get(`SELECT COUNT(*) AS n FROM keyGroups WHERE isActive = 1`)?.n ?? 0);
  assert.equal(activeCount, 1);
});

// ── C2: boot repair uses the CONFIGURED default ────────────────────────────

test("C2: an ungrouped user is repaired into the configured default, not the oldest group", async () => {
  // Oldest group is NOT the configured default.
  insertGroup("g-oldest", { name: "Oldest", isActive: 1 });
  insertGroup("g-default", { name: "Chosen", isActive: 1 });
  setDefault("g-default");
  insertUser("u1", null);

  const result = ensureCustomerGroupsSync(db);
  assert.equal(result.defaultGroupId, "g-default");
  assert.equal(db.get(`SELECT groupId FROM users WHERE id = 'u1'`).groupId, "g-default");
});

test("C2: boot repair agrees with what registration would pick", async () => {
  insertGroup("g-oldest", { name: "Oldest", isActive: 1 });
  insertGroup("g-default", { name: "Chosen", isActive: 1 });
  setDefault("g-default");
  insertUser("u1", "ghost-group");

  ensureCustomerGroupsSync(db);

  const { resolveDefaultGroupId } = await import("../src/lib/db/repos/userRepo.js");
  const registrationGroup = await resolveDefaultGroupId();
  const repaired = db.get(`SELECT groupId FROM users WHERE id = 'u1'`).groupId;
  assert.equal(repaired, registrationGroup, "boot repair and registration must agree");
});

test("C2: an invalid configured default falls back to the oldest active group", async () => {
  insertGroup("g-oldest", { name: "Oldest", isActive: 1 });
  insertGroup("g-dead", { name: "Dead", isActive: 0 });
  setDefault("g-dead");
  insertUser("u1", null);

  const result = ensureCustomerGroupsSync(db);
  assert.equal(result.defaultGroupId, "g-oldest");
  assert.equal(db.get(`SELECT groupId FROM users WHERE id = 'u1'`).groupId, "g-oldest");
});

// ── N1: a default group with no members is still the default ───────────────

test("N1: isDefault is true for a default group with zero members", async () => {
  insertGroup("g-empty", { name: "Mặc định", isActive: 1 });
  setDefault("g-empty");

  const { counts, defaultGroupId } = await groups.getGroupMemberCounts();
  assert.equal(defaultGroupId, "g-empty");
  assert.deepEqual(counts.get("g-empty"), { memberCount: 0, isDefault: true });
});

// ── N4: createUser path validates the group (route-level rule, repo-level check) ─

test("N4: an inactive group is not a valid target for a new customer", async () => {
  insertGroup("g-live", { name: "Live", isActive: 1 });
  insertGroup("g-dead", { name: "Dead", isActive: 0 });

  const live = await groups.getKeyGroupById("g-live");
  const dead = await groups.getKeyGroupById("g-dead");
  assert.equal(live.isActive, true);
  assert.equal(dead.isActive, false, "the route rejects on this flag");
});
