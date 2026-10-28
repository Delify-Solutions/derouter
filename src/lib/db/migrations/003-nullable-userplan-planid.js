// Migration 003 — userPlans.planId becomes nullable.
//
// A credit-only grant genuinely has no plan behind it: a gift code with
// grantKind='credit' or an admin adjustment credits the wallet straight into
// userPlans, and there is no plans row to point at. The column used to be
// TEXT NOT NULL, so billingRepo inserted the placeholder '' instead.
//
// SQLite has no ALTER TABLE ... DROP NOT NULL, so the table is rebuilt. The
// adapter is synchronous and the runner wraps every up() in a transaction, so
// the drop/rename pair cannot be observed half-applied.

// Every column of the pre-003 table, in declaration order. planId keeps its
// TEXT type but loses NOT NULL; the rest are copied verbatim.
const COLUMNS = [
  "id",
  "userId",
  "planId",
  "orderId",
  "source",
  "creditTotalNanoUsd",
  "creditRemainingNanoUsd",
  "startsAt",
  "expiresAt",
  "status",
  "createdAt",
];

const COLUMN_LIST = COLUMNS.join(", ");

const nullableUserplanPlanidMigration = {
  version: 3,
  name: "nullable-userplan-planid",
  up(db) {
    const cols = db.all(`PRAGMA table_info(userPlans)`);
    if (!cols.length) return; // table missing — schema sync creates it nullable

    const planId = cols.find((c) => c.name === "planId");
    if (!planId) return; // column missing — nothing to relax
    if (!planId.notnull) return; // already relaxed — idempotent

    // One statement per exec(): all three drivers accept multi-statement SQL in
    // exec(), but splitting keeps each step atomic and driver-independent.
    db.exec(`DROP TABLE IF EXISTS userPlans_new`);
    db.exec(`
      CREATE TABLE userPlans_new (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        planId TEXT,
        orderId TEXT,
        source TEXT NOT NULL,
        creditTotalNanoUsd INTEGER NOT NULL,
        creditRemainingNanoUsd INTEGER NOT NULL,
        startsAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        status TEXT NOT NULL,
        createdAt TEXT
      )
    `);
    db.exec(`INSERT INTO userPlans_new (${COLUMN_LIST}) SELECT ${COLUMN_LIST} FROM userPlans`);
    db.exec(`DROP TABLE userPlans`);
    db.exec(`ALTER TABLE userPlans_new RENAME TO userPlans`);
    // Dropping the table dropped its indexes too, so recreate the lookup index.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_up_user ON userPlans(userId, status, expiresAt)`);

    // Rows written while the column was NOT NULL carry billingRepo's NO_PLAN_ID
    // placeholder "" — they mean "no plan", so make that explicit.
    db.exec(`UPDATE userPlans SET planId = NULL WHERE planId = ''`);
  },
};
export default nullableUserplanPlanidMigration;
