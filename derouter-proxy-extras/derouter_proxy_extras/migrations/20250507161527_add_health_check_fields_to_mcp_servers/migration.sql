-- Add health check fields to MCP server table
ALTER TABLE "DeRouter_MCPServerTable" ADD COLUMN IF NOT EXISTS "status" TEXT DEFAULT 'unknown';
ALTER TABLE "DeRouter_MCPServerTable" ADD COLUMN IF NOT EXISTS "last_health_check" TIMESTAMP(3);
ALTER TABLE "DeRouter_MCPServerTable" ADD COLUMN IF NOT EXISTS "health_check_error" TEXT; 