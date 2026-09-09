-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeRouter_VerificationToken_user_id_team_id_idx" ON "DeRouter_VerificationToken"("user_id", "team_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeRouter_VerificationToken_team_id_idx" ON "DeRouter_VerificationToken"("team_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeRouter_VerificationToken_budget_reset_at_expires_idx" ON "DeRouter_VerificationToken"("budget_reset_at", "expires");
