-- CreateTable
CREATE TABLE IF NOT EXISTS "DeRouter_DailyGuardrailMetrics" (
    "guardrail_id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "requests_evaluated" BIGINT NOT NULL DEFAULT 0,
    "passed_count" BIGINT NOT NULL DEFAULT 0,
    "blocked_count" BIGINT NOT NULL DEFAULT 0,
    "flagged_count" BIGINT NOT NULL DEFAULT 0,
    "avg_score" DOUBLE PRECISION,
    "avg_latency_ms" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeRouter_DailyGuardrailMetrics_pkey" PRIMARY KEY ("guardrail_id","date")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "DeRouter_DailyPolicyMetrics" (
    "policy_id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "requests_evaluated" BIGINT NOT NULL DEFAULT 0,
    "passed_count" BIGINT NOT NULL DEFAULT 0,
    "blocked_count" BIGINT NOT NULL DEFAULT 0,
    "flagged_count" BIGINT NOT NULL DEFAULT 0,
    "avg_score" DOUBLE PRECISION,
    "avg_latency_ms" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeRouter_DailyPolicyMetrics_pkey" PRIMARY KEY ("policy_id","date")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "DeRouter_SpendLogGuardrailIndex" (
    "request_id" TEXT NOT NULL,
    "guardrail_id" TEXT NOT NULL,
    "policy_id" TEXT,
    "start_time" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeRouter_SpendLogGuardrailIndex_pkey" PRIMARY KEY ("request_id","guardrail_id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeRouter_DailyGuardrailMetrics_date_idx" ON "DeRouter_DailyGuardrailMetrics"("date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeRouter_DailyGuardrailMetrics_guardrail_id_idx" ON "DeRouter_DailyGuardrailMetrics"("guardrail_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeRouter_DailyPolicyMetrics_date_idx" ON "DeRouter_DailyPolicyMetrics"("date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeRouter_DailyPolicyMetrics_policy_id_idx" ON "DeRouter_DailyPolicyMetrics"("policy_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeRouter_SpendLogGuardrailIndex_guardrail_id_start_time_idx" ON "DeRouter_SpendLogGuardrailIndex"("guardrail_id", "start_time");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeRouter_SpendLogGuardrailIndex_policy_id_start_time_idx" ON "DeRouter_SpendLogGuardrailIndex"("policy_id", "start_time");

