-- AlterTable
ALTER TABLE "DeRouter_ShadowEvalJob" ADD COLUMN     "max_budget" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "DeRouter_ShadowEvalAttempt" ADD COLUMN     "shadow_cost" DOUBLE PRECISION NOT NULL DEFAULT 0;
