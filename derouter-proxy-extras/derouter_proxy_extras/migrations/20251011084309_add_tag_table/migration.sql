-- CreateTable
CREATE TABLE IF NOT EXISTS "DeRouter_TagTable" (
    "tag_name" TEXT NOT NULL,
    "description" TEXT,
    "models" TEXT[],
    "model_info" JSONB,
    "spend" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "budget_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeRouter_TagTable_pkey" PRIMARY KEY ("tag_name")
);

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DeRouter_TagTable_budget_id_fkey') THEN
        ALTER TABLE "DeRouter_TagTable" ADD CONSTRAINT "DeRouter_TagTable_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "DeRouter_BudgetTable"("budget_id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

