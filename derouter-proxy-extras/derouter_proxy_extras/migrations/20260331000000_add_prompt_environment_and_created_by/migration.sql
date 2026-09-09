-- AlterTable
ALTER TABLE "DeRouter_PromptTable" ADD COLUMN "environment" TEXT NOT NULL DEFAULT 'development';
ALTER TABLE "DeRouter_PromptTable" ADD COLUMN "created_by" TEXT;

-- DropIndex (old unique constraint)
DROP INDEX IF EXISTS "DeRouter_PromptTable_prompt_id_version_key";

-- CreateIndex (new unique constraint)
CREATE UNIQUE INDEX "DeRouter_PromptTable_prompt_id_version_environment_key" ON "DeRouter_PromptTable"("prompt_id", "version", "environment");

-- CreateIndex (new composite index)
CREATE INDEX "DeRouter_PromptTable_prompt_id_environment_idx" ON "DeRouter_PromptTable"("prompt_id", "environment");
