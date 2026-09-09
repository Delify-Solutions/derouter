-- AlterTable
ALTER TABLE "DeRouter_ObjectPermissionTable" ADD COLUMN IF NOT EXISTS "models" TEXT[] DEFAULT ARRAY[]::TEXT[];

