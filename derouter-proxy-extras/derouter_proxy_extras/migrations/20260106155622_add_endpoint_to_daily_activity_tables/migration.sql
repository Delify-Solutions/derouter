-- DropIndex
DROP INDEX IF EXISTS "DeRouter_DailyAgentSpend_agent_id_date_api_key_model_custom__key";

-- DropIndex
DROP INDEX IF EXISTS "DeRouter_DailyEndUserSpend_end_user_id_date_api_key_model_cu_key";

-- DropIndex
DROP INDEX IF EXISTS "DeRouter_DailyOrganizationSpend_organization_id_date_api_key_key";

-- DropIndex
DROP INDEX IF EXISTS "DeRouter_DailyTagSpend_tag_date_api_key_model_custom_llm_pro_key";

-- DropIndex
DROP INDEX IF EXISTS "DeRouter_DailyTeamSpend_team_id_date_api_key_model_custom_ll_key";

-- DropIndex
DROP INDEX IF EXISTS "DeRouter_DailyUserSpend_user_id_date_api_key_model_custom_ll_key";

-- AlterTable
ALTER TABLE "DeRouter_DailyAgentSpend" ADD COLUMN IF NOT EXISTS "endpoint" TEXT;

-- AlterTable
ALTER TABLE "DeRouter_DailyEndUserSpend" ADD COLUMN IF NOT EXISTS "endpoint" TEXT;

-- AlterTable
ALTER TABLE "DeRouter_DailyOrganizationSpend" ADD COLUMN IF NOT EXISTS "endpoint" TEXT;

-- AlterTable
ALTER TABLE "DeRouter_DailyTagSpend" ADD COLUMN IF NOT EXISTS "endpoint" TEXT;

-- AlterTable
ALTER TABLE "DeRouter_DailyTeamSpend" ADD COLUMN IF NOT EXISTS "endpoint" TEXT;

-- AlterTable
ALTER TABLE "DeRouter_DailyUserSpend" ADD COLUMN IF NOT EXISTS "endpoint" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeRouter_DailyAgentSpend_endpoint_idx" ON "DeRouter_DailyAgentSpend"("endpoint");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DeRouter_DailyAgentSpend_agent_id_date_api_key_model_custom__key" ON "DeRouter_DailyAgentSpend"("agent_id", "date", "api_key", "model", "custom_llm_provider", "mcp_namespaced_tool_name", "endpoint");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeRouter_DailyEndUserSpend_endpoint_idx" ON "DeRouter_DailyEndUserSpend"("endpoint");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DeRouter_DailyEndUserSpend_end_user_id_date_api_key_model_cu_key" ON "DeRouter_DailyEndUserSpend"("end_user_id", "date", "api_key", "model", "custom_llm_provider", "mcp_namespaced_tool_name", "endpoint");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeRouter_DailyOrganizationSpend_endpoint_idx" ON "DeRouter_DailyOrganizationSpend"("endpoint");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DeRouter_DailyOrganizationSpend_organization_id_date_api_key_key" ON "DeRouter_DailyOrganizationSpend"("organization_id", "date", "api_key", "model", "custom_llm_provider", "mcp_namespaced_tool_name", "endpoint");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeRouter_DailyTagSpend_endpoint_idx" ON "DeRouter_DailyTagSpend"("endpoint");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DeRouter_DailyTagSpend_tag_date_api_key_model_custom_llm_pro_key" ON "DeRouter_DailyTagSpend"("tag", "date", "api_key", "model", "custom_llm_provider", "mcp_namespaced_tool_name", "endpoint");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeRouter_DailyTeamSpend_endpoint_idx" ON "DeRouter_DailyTeamSpend"("endpoint");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DeRouter_DailyTeamSpend_team_id_date_api_key_model_custom_ll_key" ON "DeRouter_DailyTeamSpend"("team_id", "date", "api_key", "model", "custom_llm_provider", "mcp_namespaced_tool_name", "endpoint");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeRouter_DailyUserSpend_endpoint_idx" ON "DeRouter_DailyUserSpend"("endpoint");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DeRouter_DailyUserSpend_user_id_date_api_key_model_custom_ll_key" ON "DeRouter_DailyUserSpend"("user_id", "date", "api_key", "model", "custom_llm_provider", "mcp_namespaced_tool_name", "endpoint");

