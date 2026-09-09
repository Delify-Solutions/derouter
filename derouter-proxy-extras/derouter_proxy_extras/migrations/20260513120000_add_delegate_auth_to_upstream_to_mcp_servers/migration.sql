-- AlterTable
ALTER TABLE "DeRouter_MCPServerTable" ADD COLUMN IF NOT EXISTS "delegate_auth_to_upstream" BOOLEAN NOT NULL DEFAULT false;
