-- DropForeignKey
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DeRouter_TeamMembership_budget_id_fkey') THEN
        ALTER TABLE "DeRouter_TeamMembership" DROP CONSTRAINT "DeRouter_TeamMembership_budget_id_fkey";
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DeRouter_TeamMembership_budget_id_fkey') THEN
        ALTER TABLE "DeRouter_TeamMembership" ADD CONSTRAINT "DeRouter_TeamMembership_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "DeRouter_BudgetTable"("budget_id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

