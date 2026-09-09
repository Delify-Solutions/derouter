-- Search tool allowlists live on DeRouter_ObjectPermissionTable (with agents, MCP, vector stores).
ALTER TABLE "DeRouter_ObjectPermissionTable" ADD COLUMN IF NOT EXISTS "search_tools" TEXT[] DEFAULT ARRAY[]::TEXT[];
