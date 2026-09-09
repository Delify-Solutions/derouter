-- CreateTable
CREATE TABLE IF NOT EXISTS "DeRouter_MemoryTable" (
    "memory_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "metadata" JSONB,
    "user_id" TEXT,
    "team_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT,

    CONSTRAINT "DeRouter_MemoryTable_pkey" PRIMARY KEY ("memory_id")
);

-- CreateIndex (key is globally unique — one row per key, period)
CREATE UNIQUE INDEX IF NOT EXISTS "DeRouter_MemoryTable_key_key"
    ON "DeRouter_MemoryTable"("key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeRouter_MemoryTable_user_id_idx" ON "DeRouter_MemoryTable"("user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeRouter_MemoryTable_team_id_idx" ON "DeRouter_MemoryTable"("team_id");
