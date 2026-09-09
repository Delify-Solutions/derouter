-- DropIndex
DROP INDEX IF EXISTS "DeRouter_DailyAgentSpend_agent_id_idx";

-- DropIndex
DROP INDEX IF EXISTS "DeRouter_DailyEndUserSpend_end_user_id_idx";

-- DropIndex
DROP INDEX IF EXISTS "DeRouter_DailyOrganizationSpend_organization_id_idx";

-- DropIndex
DROP INDEX IF EXISTS "DeRouter_DailyTagSpend_tag_idx";

-- DropIndex
DROP INDEX IF EXISTS "DeRouter_DailyTeamSpend_team_id_idx";

-- DropIndex
DROP INDEX IF EXISTS "DeRouter_DailyUserSpend_user_id_idx";

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeRouter_DailyAgentSpend_agent_id_date_idx" ON "DeRouter_DailyAgentSpend"("agent_id", "date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeRouter_DailyEndUserSpend_end_user_id_date_idx" ON "DeRouter_DailyEndUserSpend"("end_user_id", "date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeRouter_DailyOrganizationSpend_organization_id_date_idx" ON "DeRouter_DailyOrganizationSpend"("organization_id", "date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeRouter_DailyTagSpend_tag_date_idx" ON "DeRouter_DailyTagSpend"("tag", "date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeRouter_DailyTeamSpend_team_id_date_idx" ON "DeRouter_DailyTeamSpend"("team_id", "date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeRouter_DailyUserSpend_user_id_date_idx" ON "DeRouter_DailyUserSpend"("user_id", "date");

