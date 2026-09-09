ALTER TABLE "DeRouter_ShadowEvalJob" ADD COLUMN IF NOT EXISTS "router_names" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "DeRouter_ShadowEvalAttempt" ADD COLUMN IF NOT EXISTS "router_name" TEXT;
