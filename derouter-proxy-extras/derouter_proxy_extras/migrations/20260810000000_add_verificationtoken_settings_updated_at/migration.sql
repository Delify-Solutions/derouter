-- AlterTable
ALTER TABLE "DeRouter_VerificationToken" ADD COLUMN IF NOT EXISTS "settings_updated_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "DeRouter_DeletedVerificationToken" ADD COLUMN IF NOT EXISTS "settings_updated_at" TIMESTAMP(3);
