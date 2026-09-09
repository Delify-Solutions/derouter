-- AlterTable
ALTER TABLE "DeRouter_DailyUserSpend" ADD COLUMN IF NOT EXISTS "compression_savings_spend" DOUBLE PRECISION NOT NULL DEFAULT 0.0;
ALTER TABLE "DeRouter_DailyUserSpend" ADD COLUMN IF NOT EXISTS "prompt_caching_savings_spend" DOUBLE PRECISION NOT NULL DEFAULT 0.0;

-- AlterTable
ALTER TABLE "DeRouter_DailyOrganizationSpend" ADD COLUMN IF NOT EXISTS "compression_savings_spend" DOUBLE PRECISION NOT NULL DEFAULT 0.0;
ALTER TABLE "DeRouter_DailyOrganizationSpend" ADD COLUMN IF NOT EXISTS "prompt_caching_savings_spend" DOUBLE PRECISION NOT NULL DEFAULT 0.0;

-- AlterTable
ALTER TABLE "DeRouter_DailyEndUserSpend" ADD COLUMN IF NOT EXISTS "compression_savings_spend" DOUBLE PRECISION NOT NULL DEFAULT 0.0;
ALTER TABLE "DeRouter_DailyEndUserSpend" ADD COLUMN IF NOT EXISTS "prompt_caching_savings_spend" DOUBLE PRECISION NOT NULL DEFAULT 0.0;

-- AlterTable
ALTER TABLE "DeRouter_DailyAgentSpend" ADD COLUMN IF NOT EXISTS "compression_savings_spend" DOUBLE PRECISION NOT NULL DEFAULT 0.0;
ALTER TABLE "DeRouter_DailyAgentSpend" ADD COLUMN IF NOT EXISTS "prompt_caching_savings_spend" DOUBLE PRECISION NOT NULL DEFAULT 0.0;

-- AlterTable
ALTER TABLE "DeRouter_DailyTeamSpend" ADD COLUMN IF NOT EXISTS "compression_savings_spend" DOUBLE PRECISION NOT NULL DEFAULT 0.0;
ALTER TABLE "DeRouter_DailyTeamSpend" ADD COLUMN IF NOT EXISTS "prompt_caching_savings_spend" DOUBLE PRECISION NOT NULL DEFAULT 0.0;

-- AlterTable
ALTER TABLE "DeRouter_DailyTagSpend" ADD COLUMN IF NOT EXISTS "compression_savings_spend" DOUBLE PRECISION NOT NULL DEFAULT 0.0;
ALTER TABLE "DeRouter_DailyTagSpend" ADD COLUMN IF NOT EXISTS "prompt_caching_savings_spend" DOUBLE PRECISION NOT NULL DEFAULT 0.0;
