-- AlterTable
ALTER TABLE "DeRouter_DeletedTeamTable" ADD COLUMN IF NOT EXISTS "router_settings" JSONB DEFAULT '{}';

-- AlterTable
ALTER TABLE "DeRouter_DeletedVerificationToken" ADD COLUMN IF NOT EXISTS "router_settings" JSONB DEFAULT '{}';

