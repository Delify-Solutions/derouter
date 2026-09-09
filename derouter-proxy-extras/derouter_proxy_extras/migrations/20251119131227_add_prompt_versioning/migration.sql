-- DropIndex
DROP INDEX IF EXISTS "DeRouter_PromptTable_prompt_id_key";

-- AlterTable
ALTER TABLE "DeRouter_PromptTable"
ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeRouter_PromptTable_prompt_id_idx" ON "DeRouter_PromptTable" ("prompt_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DeRouter_PromptTable_prompt_id_version_key" ON "DeRouter_PromptTable" ("prompt_id", "version");