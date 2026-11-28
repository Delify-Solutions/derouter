// Migration 009 — widen the provider hourly rollup to (hour, provider, connectionId).
//
// `usageRollupProvider` (spec admin-usage-views "Provider cache ratio and per-connection
// breakdown", change vendor-cost-profit) was keyed (hour, provider). Existing rolled rows
// cannot be split into per-connection rows after the fact, so the table has to go in BOTH
// places, same as migration 006 —
//   * dropped here, because syncSchemaFromTables is additive only and never widens a
//     primary key;
//   * NOT removed from TABLES in schema.js: the table itself is kept (just a new shape),
//     so the additive sync that runs right after this migration recreates it from the new
//     schema.js definition.
//
// The rollup watermark (usageRollupMeta "rolledThrough") is rewound to the oldest in-retention
// hour so the normal background hourly rollup (usageRollup.js advanceOneHourSync) re-rolls
// every hour it dropped here, from usageHistory — no bespoke backfill script needed. Hours
// outside LOG_RETENTION_DAYS are gone from usageHistory already and are simply never re-rolled,
// same as any other retention-pruned data.
//
// Destructive but recoverable: the SCHEMA_VERSION bump that accompanies this migration makes
// runMigrationOnce take the pre-change backup under DATA_DIR/db/backups/ before anything is
// touched, so the pre-widening rows survive in that file for a rollback.
const LOG_RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS || "60", 10);
const META_NAME = "rolledThrough";

const widenProviderRollupMigration = {
  version: 9,
  name: "widen-provider-rollup",
  up(db) {
    db.exec(`DROP TABLE IF EXISTS usageRollupProvider`);

    // Rewind the watermark so the background rollup re-rolls every hour this migration just
    // dropped. Never move it FORWARD (a watermark already older than the retention cutoff is
    // left alone) and only touch it when the meta table already exists (a fresh install has
    // nothing rolled yet, so there is nothing to rewind).
    try {
      const row = db.get(`SELECT value FROM usageRollupMeta WHERE name = ?`, [META_NAME]);
      if (!row?.value) return;
      const cutoffMs = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
      const cutoffIso = new Date(cutoffMs).toISOString();
      if (row.value > cutoffIso) {
        db.run(
          `INSERT INTO usageRollupMeta(name, value) VALUES(?, ?)
           ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
          [META_NAME, cutoffIso]
        );
      }
    } catch {
      // usageRollupMeta does not exist yet (fresh install) — nothing to rewind.
    }
  },
};

export default widenProviderRollupMigration;
