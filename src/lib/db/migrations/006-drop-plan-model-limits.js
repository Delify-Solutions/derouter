// Migration 006 — drop the per-model plan ceiling table.
//
// `planModelLimits` was introduced by 6fbcc1d and modelled a subscription as a
// per-model monthly ceiling. That is not the product: a purchase is one shared
// credit pool drained through a queue with per-window limits (capability
// plan-queue-billing). The table has to go in BOTH places —
//   * removed from TABLES in schema.js, otherwise syncSchemaFromTables would
//     recreate it on this very boot (it runs after the versioned migrations);
//   * dropped here, because syncSchemaFromTables is additive only and never
//     removes a table.
//
// Destructive but recoverable: the SCHEMA_VERSION bump that accompanies this
// migration makes runMigrationOnce take the pre-change backup under
// DATA_DIR/db/backups/ before anything is touched, so the old ceilings survive in
// that file for a rollback.
export default {
  version: 6,
  name: "drop-plan-model-limits",
  up(db) {
    db.exec(`DROP TABLE IF EXISTS planModelLimits`);
  },
};
