// Migration 004 — giftRedemptions loses its UNIQUE(giftId, userId).
//
// The constraint made giftCodes.perUserLimit dead weight: a code advertised as
// redeemable 3 times per account could only ever be redeemed once, and the
// resulting constraint error was reported as `already_redeemed`. The limit is
// admin-configurable, so it cannot be expressed as a static constraint; it is
// enforced by the synchronous claim transaction in redeemGiftCode instead.
//
// SQLite cannot drop a table-level UNIQUE, so the table is rebuilt. The adapter
// is synchronous and the runner wraps every up() in a transaction, so the
// drop/rename pair cannot be observed half-applied.

const TABLE = "giftRedemptions";

// Every column of the pre-004 table, in declaration order. Copied verbatim; the
// only change is the absence of the table-level UNIQUE constraint.
const COLUMNS = ["id", "giftId", "userId", "userPlanId", "redeemedAt"];

const COLUMN_LIST = COLUMNS.join(", ");

// The pre-004 shape is the one whose CREATE TABLE SQL still declares UNIQUE.
// Reading sqlite_master is the reliable test: a UNIQUE(a,b) is implemented as a
// sqlite_autoindex_* entry, and those autoindexes are easy to confuse with the
// ones a PRIMARY KEY produces.
function hasLegacyUnique(db) {
  const row = db.get(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, [TABLE]);
  if (!row?.sql) return false;
  return /\bUNIQUE\b/i.test(row.sql);
}

const giftRedemptionRepeatMigration = {
  version: 4,
  name: "gift-redemption-repeat",
  up(db) {
    const cols = db.all(`PRAGMA table_info(${TABLE})`);
    if (!cols.length) return; // table missing — schema sync creates it correct

    if (!hasLegacyUnique(db)) return; // already rebuilt — idempotent

    // One statement per exec(): all three drivers accept multi-statement SQL in
    // exec(), but splitting keeps each step atomic and driver-independent.
    db.exec(`DROP TABLE IF EXISTS ${TABLE}_new`);
    db.exec(`
      CREATE TABLE ${TABLE}_new (
        id TEXT PRIMARY KEY,
        giftId TEXT NOT NULL,
        userId TEXT NOT NULL,
        userPlanId TEXT,
        redeemedAt TEXT
      )
    `);
    db.exec(`INSERT INTO ${TABLE}_new (${COLUMN_LIST}) SELECT ${COLUMN_LIST} FROM ${TABLE}`);
    db.exec(`DROP TABLE ${TABLE}`);
    db.exec(`ALTER TABLE ${TABLE}_new RENAME TO ${TABLE}`);
    // Dropping the table dropped its indexes too, so recreate the lookup paths.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_gr_gift_user ON ${TABLE}(giftId, userId)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_gr_user ON ${TABLE}(userId)`);
  },
};
export default giftRedemptionRepeatMigration;
