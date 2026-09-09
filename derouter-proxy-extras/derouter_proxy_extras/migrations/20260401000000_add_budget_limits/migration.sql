-- AlterTable: add budget_limits column to DeRouter_VerificationToken
ALTER TABLE "DeRouter_VerificationToken" ADD COLUMN IF NOT EXISTS "budget_limits" JSONB;

-- AlterTable: add budget_limits column to DeRouter_TeamTable
ALTER TABLE "DeRouter_TeamTable" ADD COLUMN IF NOT EXISTS "budget_limits" JSONB;
