-- AlterTable
ALTER TABLE "DeRouter_ShadowEvalAttempt" ADD COLUMN IF NOT EXISTS "real_cost" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "DeRouter_ShadowEvalAttempt" ADD COLUMN IF NOT EXISTS "real_classifier_cost" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "DeRouter_ShadowEvalAttempt" ADD COLUMN IF NOT EXISTS "shadow_classifier_cost" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "DeRouter_ShadowEvalAttempt" ADD COLUMN IF NOT EXISTS "real_cache_hit" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE IF NOT EXISTS "DeRouter_ShadowEvalFunnel" (
    "job_id" TEXT NOT NULL,
    "not_sampled" INTEGER NOT NULL DEFAULT 0,
    "unjudgeable" INTEGER NOT NULL DEFAULT 0,
    "shed" INTEGER NOT NULL DEFAULT 0,
    "withheld" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DeRouter_ShadowEvalFunnel_pkey" PRIMARY KEY ("job_id")
);
