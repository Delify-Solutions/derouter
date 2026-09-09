-- AlterTable
ALTER TABLE "DeRouter_ManagedFileTable" ADD COLUMN IF NOT EXISTS "created_by" TEXT,
ADD COLUMN IF NOT EXISTS "flat_model_file_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN IF NOT EXISTS "updated_by" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "DeRouter_ManagedObjectTable" (
    "id" TEXT NOT NULL,
    "unified_object_id" TEXT NOT NULL,
    "model_object_id" TEXT NOT NULL,
    "file_object" JSONB NOT NULL,
    "file_purpose" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "DeRouter_ManagedObjectTable_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DeRouter_ManagedObjectTable_unified_object_id_key" ON "DeRouter_ManagedObjectTable"("unified_object_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DeRouter_ManagedObjectTable_model_object_id_key" ON "DeRouter_ManagedObjectTable"("model_object_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeRouter_ManagedObjectTable_unified_object_id_idx" ON "DeRouter_ManagedObjectTable"("unified_object_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeRouter_ManagedObjectTable_model_object_id_idx" ON "DeRouter_ManagedObjectTable"("model_object_id");

