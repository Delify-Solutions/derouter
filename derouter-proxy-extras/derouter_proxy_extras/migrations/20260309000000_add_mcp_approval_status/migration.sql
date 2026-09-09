-- AlterTable: Add BYOM approval workflow fields to DeRouter_MCPServerTable
ALTER TABLE "DeRouter_MCPServerTable"
  ADD COLUMN IF NOT EXISTS "approval_status" TEXT DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS "submitted_by"    TEXT,
  ADD COLUMN IF NOT EXISTS "submitted_at"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "reviewed_at"     TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "review_notes"    TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeRouter_MCPServerTable_approval_status_idx"
  ON "DeRouter_MCPServerTable"("approval_status");
