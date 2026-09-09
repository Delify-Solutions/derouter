-- CreateTable
CREATE TABLE IF NOT EXISTS "DeRouter_DailyGatewayRequests" (
    "date" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "successful_requests" BIGINT NOT NULL DEFAULT 0,
    "failed_requests" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeRouter_DailyGatewayRequests_pkey" PRIMARY KEY ("date","category","route")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeRouter_DailyGatewayRequests_date_idx" ON "DeRouter_DailyGatewayRequests"("date");
