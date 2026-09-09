-- AlterTable
ALTER TABLE "DeRouter_DailyTagSpend" ALTER COLUMN "tag" DROP NOT NULL;

-- AlterTable
ALTER TABLE "DeRouter_DailyTeamSpend" ALTER COLUMN "team_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "DeRouter_DailyUserSpend" ALTER COLUMN "user_id" DROP NOT NULL;

