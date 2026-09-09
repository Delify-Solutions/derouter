-- CreateTable
CREATE TABLE IF NOT EXISTS "DeRouter_DailyToolSpend" (
    "date" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "spend" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "total_tokens" BIGINT NOT NULL DEFAULT 0,
    "request_count" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeRouter_DailyToolSpend_pkey" PRIMARY KEY ("date","tool_name")
);
