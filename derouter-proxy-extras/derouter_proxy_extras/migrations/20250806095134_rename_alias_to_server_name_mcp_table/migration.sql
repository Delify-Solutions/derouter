-- Migration for existing tables: rename alias to server_name if upgrading
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'DeRouter_MCPServerTable' AND column_name = 'alias') THEN
        ALTER TABLE "DeRouter_MCPServerTable" RENAME COLUMN "alias" TO "server_name";
    END IF;
END $$;

-- Migration for existing tables: add alias column if upgrading
ALTER TABLE "DeRouter_MCPServerTable" ADD COLUMN IF NOT EXISTS "alias" TEXT; 