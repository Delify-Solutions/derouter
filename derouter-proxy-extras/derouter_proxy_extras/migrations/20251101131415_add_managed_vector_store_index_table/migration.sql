-- CreateTable
CREATE TABLE IF NOT EXISTS "DeRouter_ManagedVectorStoreIndexTable" (
    "id" TEXT NOT NULL,
    "index_name" TEXT NOT NULL,
    "derouter_params" JSONB NOT NULL,
    "index_info" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "DeRouter_ManagedVectorStoreIndexTable_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DeRouter_ManagedVectorStoreIndexTable_index_name_key" ON "DeRouter_ManagedVectorStoreIndexTable"("index_name");

