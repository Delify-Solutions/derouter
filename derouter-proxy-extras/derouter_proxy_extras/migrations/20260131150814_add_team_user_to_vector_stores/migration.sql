-- AlterTable
ALTER TABLE "DeRouter_ManagedVectorStoresTable"
    ADD COLUMN IF NOT EXISTS "team_id" TEXT,
    ADD COLUMN IF NOT EXISTS "user_id" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeRouter_ManagedVectorStoresTable_team_id_idx"
    ON "DeRouter_ManagedVectorStoresTable"("team_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeRouter_ManagedVectorStoresTable_user_id_idx"
    ON "DeRouter_ManagedVectorStoresTable"("user_id");

