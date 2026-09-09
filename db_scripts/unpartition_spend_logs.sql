-- Rolls back db_scripts/partition_spend_logs.sql: converts the native
-- range-partitioned "DeRouter_SpendLogs" table back into a plain,
-- non-partitioned table matching the default DeRouter schema.
--
-- When/why: run this if you want to stop using partition-based retention and
-- return to DELETE-based cleanup, or to restore the original single-column
-- primary key ("request_id") that the partitioned layout had to widen to a
-- composite ("request_id", "startTime").
--
-- IMPORTANT
--   * Test on a staging copy first and take a backup.
--   * Postgres cannot convert a partitioned table back in place, so this
--     renames the partitioned table aside and creates a fresh plain table.
--   * The composite PK could in principle hold the same "request_id" in more
--     than one partition, so rows are copied with ON CONFLICT DO NOTHING to
--     restore the single-column PK without failing on such duplicates.
--   * For large tables the INSERT ... SELECT copies every surviving row and may
--     run long; do it during a low-traffic window.
--   * Also remove use_spend_logs_partitioning from proxy_config.yaml (or set it
--     to false) so the cleanup job returns to DELETE-based retention.

BEGIN;

ALTER TABLE "DeRouter_SpendLogs" RENAME TO "DeRouter_SpendLogs_partitioned";

-- Renaming a table does NOT rename its indexes, and index names are unique per
-- schema. Move the partitioned table's indexes aside so the CREATE INDEX
-- statements below actually create indexes on the new plain table instead of
-- being silently skipped by IF NOT EXISTS, and so the new PK keeps the
-- canonical name.
ALTER INDEX IF EXISTS "DeRouter_SpendLogs_pkey"
    RENAME TO "DeRouter_SpendLogs_partitioned_pkey";
ALTER INDEX IF EXISTS "DeRouter_SpendLogs_pkey1"
    RENAME TO "DeRouter_SpendLogs_partitioned_pkey1";
ALTER INDEX IF EXISTS "DeRouter_SpendLogs_startTime_idx"
    RENAME TO "DeRouter_SpendLogs_partitioned_startTime_idx";
ALTER INDEX IF EXISTS "DeRouter_SpendLogs_startTime_request_id_idx"
    RENAME TO "DeRouter_SpendLogs_partitioned_startTime_request_id_idx";
ALTER INDEX IF EXISTS "DeRouter_SpendLogs_end_user_idx"
    RENAME TO "DeRouter_SpendLogs_partitioned_end_user_idx";
ALTER INDEX IF EXISTS "DeRouter_SpendLogs_session_id_idx"
    RENAME TO "DeRouter_SpendLogs_partitioned_session_id_idx";

CREATE TABLE "DeRouter_SpendLogs" (
    LIKE "DeRouter_SpendLogs_partitioned" INCLUDING DEFAULTS INCLUDING GENERATED
);

ALTER TABLE "DeRouter_SpendLogs"
    ADD PRIMARY KEY ("request_id");

CREATE INDEX IF NOT EXISTS "DeRouter_SpendLogs_startTime_idx"
    ON "DeRouter_SpendLogs" ("startTime");

CREATE INDEX IF NOT EXISTS "DeRouter_SpendLogs_startTime_request_id_idx"
    ON "DeRouter_SpendLogs" ("startTime", "request_id");

CREATE INDEX IF NOT EXISTS "DeRouter_SpendLogs_end_user_idx"
    ON "DeRouter_SpendLogs" ("end_user");

CREATE INDEX IF NOT EXISTS "DeRouter_SpendLogs_session_id_idx"
    ON "DeRouter_SpendLogs" ("session_id");

INSERT INTO "DeRouter_SpendLogs"
SELECT * FROM "DeRouter_SpendLogs_partitioned"
ON CONFLICT ("request_id") DO NOTHING;

DROP TABLE "DeRouter_SpendLogs_partitioned";

COMMIT;
