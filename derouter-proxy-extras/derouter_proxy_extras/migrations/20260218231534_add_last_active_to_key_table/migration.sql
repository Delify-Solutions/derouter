-- AlterTable
ALTER TABLE "DeRouter_DeletedVerificationToken" ADD COLUMN IF NOT EXISTS "last_active" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "DeRouter_VerificationToken" ADD COLUMN IF NOT EXISTS "last_active" TIMESTAMP(3);

