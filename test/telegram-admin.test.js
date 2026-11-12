// Admin management of Telegram links (change telegram-admin).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-telegram-admin-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const repo = await import("../src/lib/db/repos/telegramLinkRepo.js");

let db;
before(async () => { db = await getAdapter(); });
after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(() => {
  for (const t of ["users", "userAuditLog", "activityLog", "telegramLinkTokens", "giftRedemptions"]) {
    try { db.run(`DELETE FROM ${t}`); } catch { /* ignore */ }
  }
});

function user(id, { tgId = null, tgName = null, linkedAt = "2026-11-01T00:00:00.000Z", email = `${id}@test.local` } = {}) {
  db.run(
    `INSERT INTO users(id, email, passwordHash, status, overdraftNanoUsd, telegramUserId, telegramUsername, telegramLinkedAt, createdAt, updatedAt)
     VALUES(?, ?, 'x', 'active', 0, ?, ?, ?, ?, ?)`,
    [id, email, tgId, tgName, tgId ? linkedAt : null, linkedAt, linkedAt]
  );
}

test("the list shows linked accounts only, newest link first, and searches email, @username and id", () => {
  user("a", { tgId: "111", tgName: "alice", linkedAt: "2026-11-01T00:00:00.000Z" });
  user("b", { tgId: "222", tgName: "bob_x", linkedAt: "2026-11-03T00:00:00.000Z" });
  user("c");
  const all = repo.listTelegramLinksSync(db);
  assert.equal(all.total, 2);
  assert.deepEqual(all.rows.map((r) => r.userId), ["b", "a"]);
  assert.deepEqual(repo.listTelegramLinksSync(db, { q: "@ALICE" }).rows.map((r) => r.userId), ["a"]);
  user("d", { tgId: "333", tgName: "zed", email: "alice.nguyen@test.local" });
  assert.deepEqual(repo.listTelegramLinksSync(db, { q: "@alice" }).rows.map((r) => r.userId), ["a"], "@ searches the username only");
  assert.deepEqual(repo.listTelegramLinksSync(db, { q: "alice" }).rows.map((r) => r.userId).sort(), ["a", "d"]);
  assert.deepEqual(repo.listTelegramLinksSync(db, { q: "222" }).rows.map((r) => r.userId), ["b"]);
  assert.deepEqual(repo.listTelegramLinksSync(db, { q: "a@test" }).rows.map((r) => r.userId), ["a"]);
  assert.equal(repo.listTelegramLinksSync(db, { q: "_" }).total, 1, "an underscore is literal (only bob_x)");
});

test("admin unlink clears the link, is audited and shows in the customer's activity", () => {
  user("a", { tgId: "111", tgName: "alice" });
  db.run(`INSERT INTO giftRedemptions(id, giftId, userId, redeemedAt, telegramUserId) VALUES('r1', 'g1', 'a', '2026-11-01', '111')`);
  const result = db.transaction(() => repo.adminUnlinkTelegramSync(db, "a", { actor: "admin:t", reason: "linked by mistake" }));
  assert.equal(result.ok, true);
  assert.equal(repo.getTelegramLinkSync(db, "a").linked, false);
  const audit = db.get(`SELECT actor, action, reason, details FROM userAuditLog WHERE userId = 'a'`);
  assert.equal(audit.action, "telegram_unlinked");
  assert.equal(audit.actor, "admin:t");
  assert.equal(audit.reason, "linked by mistake");
  assert.deepEqual(JSON.parse(audit.details), { telegramUserId: "111", telegramUsername: "alice" });
  const activity = db.get(`SELECT action, details FROM activityLog WHERE userId = 'a'`);
  assert.equal(activity.action, "telegram_unlink");
  assert.equal(JSON.parse(activity.details).by, "admin");
  assert.equal(db.get(`SELECT telegramUserId FROM giftRedemptions WHERE id = 'r1'`).telegramUserId, "111", "the gift snapshot stays");
});

test("the unlink is refused when the link changed since the notice", () => {
  user("a", { tgId: "999", tgName: "new_one" });
  assert.deepEqual(db.transaction(() => repo.adminUnlinkTelegramSync(db, "a", { expectTelegramUserId: "111" })), { error: "changed" });
  assert.equal(repo.getTelegramLinkSync(db, "a").linked, true);
});

test("unlinking an unlinked or unknown account reports why", () => {
  user("c");
  assert.deepEqual(db.transaction(() => repo.adminUnlinkTelegramSync(db, "c")), { error: "not_linked" });
  assert.deepEqual(db.transaction(() => repo.adminUnlinkTelegramSync(db, "nope")), { error: "not_found" });
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM userAuditLog`).n, 0);
});
