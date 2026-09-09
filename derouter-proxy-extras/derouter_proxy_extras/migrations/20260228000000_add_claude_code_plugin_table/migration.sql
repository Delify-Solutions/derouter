-- CreateTable
CREATE TABLE IF NOT EXISTS "DeRouter_ClaudeCodePluginTable" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT,
    "description" TEXT,
    "manifest_json" TEXT,
    "files_json" TEXT DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "DeRouter_ClaudeCodePluginTable_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DeRouter_ClaudeCodePluginTable_name_key" ON "DeRouter_ClaudeCodePluginTable"("name");
