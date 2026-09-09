ALTER TABLE "DeRouter_ShadowEvalJob" ADD COLUMN IF NOT EXISTS "group_id" TEXT;

UPDATE "DeRouter_ShadowEvalJob" SET "group_id" = "id" WHERE "group_id" IS NULL;

ALTER TABLE "DeRouter_ShadowEvalJob" ALTER COLUMN "group_id" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "DeRouter_ShadowEvalJob_group_id_idx" ON "DeRouter_ShadowEvalJob"("group_id");
