// Migration 002 — money as integer nanoUSD + tenant/key-hash columns.
//
// Additive by design: the new tables (users, plans, orders, ...) and their
// indexes are declared in schema.js TABLES and created by syncSchemaFromTables
// right after this migration runs, so nothing here recreates tables.
//
// What must happen here is the data backfill: legacy rows only carry the float
// `cost` column, and legacy keys only carry the raw `key` string. Backfill the
// new columns once, so readers can rely on them.

// Add a column when the table exists but predates it. Version-1 databases have
// the old shape and syncSchemaFromTables runs *after* this migration, so the
// new columns cannot be assumed present. Only additive changes belong here.
function ensureColumn(db, table, column, definition) {
  const cols = db.all(`PRAGMA table_info(${table})`);
  if (!cols.length) return; // table missing entirely — schema sync creates it
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

const moneyAndTenantsMigration = {
  version: 2,
  name: "money-and-tenants",
  up(db) {
    // 1. usageHistory.costNanoUsd — authoritative integer cost. Backfill from
    // the legacy float, rounding once into integer nanoUSD (1e-9 USD).
    ensureColumn(db, "usageHistory", "costNanoUsd", "INTEGER DEFAULT 0");
    db.exec(`
      UPDATE usageHistory
         SET costNanoUsd = CAST(ROUND(COALESCE(cost, 0) * 1000000000) AS INTEGER)
    `);

    // 2. apiKeys — dual-read lookup support. Old keys keep working through the
    // raw `key` column, which is kept; keyHash stays NULL for legacy rows and
    // is only populated by writers going forward (apiKeysRepo.createApiKey).
    ensureColumn(db, "apiKeys", "keyPrefix", "TEXT");
    ensureColumn(db, "apiKeys", "keyHash", "TEXT");
    db.exec(`
      UPDATE apiKeys
         SET keyPrefix = SUBSTR(key, 1, 8)
       WHERE keyPrefix IS NULL AND key IS NOT NULL
    `);
  },
};
export default moneyAndTenantsMigration;
