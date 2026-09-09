-- Add agent permission fields to DeRouter_ObjectPermissionTable
ALTER TABLE "DeRouter_ObjectPermissionTable" ADD COLUMN IF NOT EXISTS "agents" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "DeRouter_ObjectPermissionTable" ADD COLUMN IF NOT EXISTS "agent_access_groups" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Add agent_access_groups field to DeRouter_AgentsTable  
ALTER TABLE "DeRouter_AgentsTable" ADD COLUMN IF NOT EXISTS "agent_access_groups" TEXT[] DEFAULT ARRAY[]::TEXT[];

