-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeRouter_TeamTable_organization_id_idx" ON "DeRouter_TeamTable"("organization_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeRouter_TeamTable_team_alias_idx" ON "DeRouter_TeamTable"("team_alias");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeRouter_TeamTable_created_at_idx" ON "DeRouter_TeamTable"("created_at");

