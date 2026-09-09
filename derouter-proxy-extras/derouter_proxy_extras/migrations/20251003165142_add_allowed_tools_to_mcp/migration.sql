-- AlterTable
ALTER TABLE "DeRouter_MCPServerTable" ADD COLUMN IF NOT EXISTS "allowed_tools" TEXT[] DEFAULT ARRAY[]::TEXT[];

