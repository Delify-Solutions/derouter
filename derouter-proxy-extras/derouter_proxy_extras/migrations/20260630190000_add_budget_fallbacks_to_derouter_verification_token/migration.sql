-- AlterTable
ALTER TABLE "DeRouter_VerificationToken" ADD COLUMN IF NOT EXISTS "budget_fallbacks" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "DeRouter_DeletedVerificationToken" ADD COLUMN IF NOT EXISTS "budget_fallbacks" JSONB NOT NULL DEFAULT '{}';
