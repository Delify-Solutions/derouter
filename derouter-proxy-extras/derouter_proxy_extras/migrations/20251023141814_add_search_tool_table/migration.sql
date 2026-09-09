-- CreateTable
CREATE TABLE IF NOT EXISTS "DeRouter_SearchToolsTable" (
    "search_tool_id" TEXT NOT NULL,
    "search_tool_name" TEXT NOT NULL,
    "derouter_params" JSONB NOT NULL,
    "search_tool_info" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeRouter_SearchToolsTable_pkey" PRIMARY KEY ("search_tool_id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DeRouter_SearchToolsTable_search_tool_name_key" ON "DeRouter_SearchToolsTable"("search_tool_name");

