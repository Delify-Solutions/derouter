-- CreateTable
CREATE TABLE IF NOT EXISTS "DeRouter_MCPServerOAuthClient" (
    "server_id" TEXT NOT NULL,
    "credentials" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeRouter_MCPServerOAuthClient_pkey" PRIMARY KEY ("server_id")
);
