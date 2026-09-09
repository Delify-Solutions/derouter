-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeRouter_SpendLogs_startTime_request_id_idx" ON "DeRouter_SpendLogs"("startTime", "request_id");
