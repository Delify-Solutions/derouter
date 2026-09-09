-- AlterTable
ALTER TABLE "DeRouter_MCPServerTable" ADD COLUMN IF NOT EXISTS "credentials" JSONB DEFAULT '{}';
