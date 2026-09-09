-- AlterTable
ALTER TABLE "DeRouter_ShadowEvalJob" ADD COLUMN     "baseline_model" TEXT,
ADD COLUMN     "direction" TEXT NOT NULL DEFAULT 'forward';

DROP INDEX IF EXISTS "DeRouter_ShadowEvalJob_one_active_per_key";

CREATE UNIQUE INDEX IF NOT EXISTS "DeRouter_ShadowEvalJob_one_active_per_key_direction"
    ON "DeRouter_ShadowEvalJob"("api_key_id", "direction") WHERE "stopped_at" IS NULL;
