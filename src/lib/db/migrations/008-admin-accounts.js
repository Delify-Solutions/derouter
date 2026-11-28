// Migration 008 — admin accounts: replace the single shared password with named
// accounts, with the owner's existing password becoming a default Super Admin.
//
// adminUsers / adminPermissions are brand new tables (spec admin-accounts). Unlike
// every other migration here, this one has to create them itself: the additive
// sync in migrate.js (syncSchemaFromTables) that normally creates new tables
// declared in schema.js TABLES runs AFTER the versioned migrations chain, so a
// migration cannot assume a table it needs to insert into already exists. Creating
// it here with the exact DDL schema.js would produce is safe — the later sync step
// finds the table already present and only adds whatever columns/indexes a FUTURE
// schema.js change declares that this migration never had to know about.
//
// Idempotent: the backfill only fires when no `super_admin` row exists yet, so
// running this up() a second time (not something the skip-version-safe runner
// does, but cheap to guard anyway) never creates a second Super Admin. A fresh
// install has no `settings` row yet either (it is itself created by the same
// additive sync, after this migration runs) — passwordHash is then left NULL,
// which the login path already treats exactly like "no settings.password set".
import { TABLES, buildCreateTableSql } from "../schema.js";

const adminAccountsMigration = {
  version: 8,
  name: "admin-accounts",
  up(db) {
    db.exec(buildCreateTableSql("adminUsers", TABLES.adminUsers));
    db.exec(buildCreateTableSql("adminPermissions", TABLES.adminPermissions));

    const existing = db.get(`SELECT id FROM adminUsers WHERE role = 'super_admin' LIMIT 1`);
    if (existing) return;

    let passwordHash = null;
    try {
      const settingsRow = db.get(`SELECT data FROM settings WHERE id = 1`);
      if (settingsRow?.data) {
        const data = JSON.parse(settingsRow.data);
        passwordHash = data?.password || null;
      }
    } catch {
      // Malformed settings row, or the table does not exist yet (fresh install):
      // fall through with no password, same state a fresh install already has.
    }

    const now = new Date().toISOString();
    const id = `admin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    db.run(
      `INSERT INTO adminUsers(id, username, passwordHash, displayName, role, status, mustChangePassword, sessionsValidAfter, createdAt, updatedAt)
       VALUES(?, 'admin', ?, 'Super Admin', 'super_admin', 'active', 0, 0, ?, ?)`,
      [id, passwordHash, now, now]
    );
  },
};

export default adminAccountsMigration;
