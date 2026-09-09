-- AlterTable
ALTER TABLE "DeRouter_ManagedFileTable" ADD COLUMN IF NOT EXISTS "storage_backend" TEXT;
ALTER TABLE "DeRouter_ManagedFileTable" ADD COLUMN IF NOT EXISTS "storage_url" TEXT;

