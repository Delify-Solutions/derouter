-- CreateTable
CREATE TABLE IF NOT EXISTS "DeRouter_GuardrailsTable" (
    "guardrail_id" TEXT NOT NULL,
    "guardrail_name" TEXT NOT NULL,
    "derouter_params" JSONB NOT NULL,
    "guardrail_info" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeRouter_GuardrailsTable_pkey" PRIMARY KEY ("guardrail_id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DeRouter_GuardrailsTable_guardrail_name_key" ON "DeRouter_GuardrailsTable"("guardrail_name");

