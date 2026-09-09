-- AlterTable: Add source_url field to DeRouter_MCPServerTable for GitHub/docs link
ALTER TABLE "DeRouter_MCPServerTable"
  ADD COLUMN IF NOT EXISTS "source_url" TEXT;
