-- AlterTable
ALTER TABLE "DeRouter_MCPServerTable" ADD COLUMN IF NOT EXISTS "allow_all_keys" BOOLEAN NOT NULL DEFAULT false;

