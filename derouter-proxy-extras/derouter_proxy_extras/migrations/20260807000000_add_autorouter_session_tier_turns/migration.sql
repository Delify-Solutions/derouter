ALTER TABLE "DeRouter_AutoRouterSession" ADD COLUMN IF NOT EXISTS "tier_turns" JSONB NOT NULL DEFAULT '{}';
