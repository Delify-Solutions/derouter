-- AlterTable
ALTER TABLE "DeRouter_MCPServerTable" ADD COLUMN IF NOT EXISTS "byok_api_key_help_url" TEXT,
ADD COLUMN IF NOT EXISTS "byok_description" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN IF NOT EXISTS "is_byok" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "tool_name_to_description" JSONB DEFAULT '{}',
ADD COLUMN IF NOT EXISTS "tool_name_to_display_name" JSONB DEFAULT '{}';

-- CreateTable
CREATE TABLE IF NOT EXISTS "DeRouter_MCPUserCredentials" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "server_id" TEXT NOT NULL,
    "credential_b64" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeRouter_MCPUserCredentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "DeRouter_JWTKeyMapping" (
    "id" TEXT NOT NULL,
    "jwt_claim_name" TEXT NOT NULL,
    "jwt_claim_value" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT,

    CONSTRAINT "DeRouter_JWTKeyMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "DeRouter_ConfigOverrides" (
    "config_type" TEXT NOT NULL,
    "config_value" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeRouter_ConfigOverrides_pkey" PRIMARY KEY ("config_type")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DeRouter_MCPUserCredentials_user_id_server_id_key" ON "DeRouter_MCPUserCredentials"("user_id", "server_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeRouter_JWTKeyMapping_jwt_claim_name_jwt_claim_value_is_act_idx" ON "DeRouter_JWTKeyMapping"("jwt_claim_name", "jwt_claim_value", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DeRouter_JWTKeyMapping_jwt_claim_name_jwt_claim_value_key" ON "DeRouter_JWTKeyMapping"("jwt_claim_name", "jwt_claim_value");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DeRouter_JWTKeyMapping_token_fkey') THEN
        ALTER TABLE "DeRouter_JWTKeyMapping" ADD CONSTRAINT "DeRouter_JWTKeyMapping_token_fkey" FOREIGN KEY ("token") REFERENCES "DeRouter_VerificationToken"("token") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;

