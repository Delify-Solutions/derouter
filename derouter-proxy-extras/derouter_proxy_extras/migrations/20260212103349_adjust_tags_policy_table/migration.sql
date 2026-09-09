-- AlterTable
ALTER TABLE "DeRouter_PolicyAttachmentTable" ADD COLUMN IF NOT EXISTS "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

