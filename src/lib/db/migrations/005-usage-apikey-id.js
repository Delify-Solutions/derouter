// Migration 005 — usageHistory.apiKeyId, so usage rows no longer need the raw
// API-key secret to stay attributable.
//
// New rows written by usageRepo.saveRequestUsage carry apiKeyId and leave the
// deprecated `apiKey` column NULL. Historical rows only have the raw key, so
// this migration resolves each distinct raw key once and backfills its id.
//
// Additive: the column is declared in schema.js TABLES and added by
// syncSchemaFromTables if it is still missing (version-6 databases predate it and
// syncSchemaFromTables runs *after* this migration), but the migration adds it
// itself first — same reason migration 002's ensureColumn does: it must be able
// to backfill on the run where it is first applied, and that ALTER is idempotent
// against the later schema sync.
//
// Matching rule mirrors resolveApiKeyOwner: a row key may still live in
// apiKeys.key (legacy), or only its sha256 survive in apiKeys.keyHash (plaintext
// removed from the apiKeys row), so both are tried. Unknown keys (an
// admin/local key that predates tenant ownership) keep a NULL apiKeyId and stay
// attributable through the raw apiKey they already carry.

import crypto from "node:crypto";

function sha256Hex(value) {
  if (!value || typeof value !== "string") return null;
  return crypto.createHash("sha256").update(value).digest("hex");
}

function tableExists(db, name) {
  const row = db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [name]);
  return !!row;
}

function hasColumn(db, table, column) {
  return db.all(`PRAGMA table_info(${table})`).some((c) => c.name === column);
}

const usageApikeyIdMigration = {
  version: 5,
  name: "usage-apikey-id",
  up(db) {
    if (!tableExists(db, "usageHistory") || !tableExists(db, "apiKeys")) return;
    if (!hasColumn(db, "usageHistory", "apiKeyId")) {
      // SQLite ADD COLUMN is cheap and metadata-only; the runner's transaction
      // makes a failure here roll back the whole migration.
      db.exec(`ALTER TABLE usageHistory ADD COLUMN apiKeyId TEXT`);
    }

    // Set-wise on purpose: one SELECT of the distinct keys that still lack an id,
    // one lookup per distinct key (not per row), then one UPDATE per resolved
    // id. Rows that already carry apiKeyId are excluded, so a second run finds
    // nothing to do and the migration is idempotent.
    const pending = db.all(`
      SELECT DISTINCT apiKey
        FROM usageHistory
       WHERE apiKeyId IS NULL
         AND apiKey IS NOT NULL
         AND apiKey != ''
    `);
    if (!pending.length) return;

    const updates = [];
    for (const { apiKey } of pending) {
      let row = db.get(`SELECT id FROM apiKeys WHERE key = ?`, [apiKey]);
      if (!row) {
        const hash = sha256Hex(apiKey);
        if (hash) row = db.get(`SELECT id FROM apiKeys WHERE keyHash = ?`, [hash]);
      }
      if (row?.id) updates.push({ apiKeyId: row.id, apiKey });
    }

    for (const { apiKeyId, apiKey } of updates) {
      db.run(`UPDATE usageHistory SET apiKeyId = ? WHERE apiKey = ? AND apiKeyId IS NULL`, [apiKeyId, apiKey]);
    }
  },
};
export default usageApikeyIdMigration;
