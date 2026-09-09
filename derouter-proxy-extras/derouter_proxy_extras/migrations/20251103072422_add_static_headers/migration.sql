-- AlterTable
ALTER TABLE "DeRouter_MCPServerTable" ADD COLUMN IF NOT EXISTS "static_headers" JSONB DEFAULT '{}';
