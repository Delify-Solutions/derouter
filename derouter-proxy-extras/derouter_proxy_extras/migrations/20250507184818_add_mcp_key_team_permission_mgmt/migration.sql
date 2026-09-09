-- AlterTable
ALTER TABLE "DeRouter_OrganizationTable" ADD COLUMN IF NOT EXISTS "object_permission_id" TEXT;

-- AlterTable
ALTER TABLE "DeRouter_TeamTable" ADD COLUMN IF NOT EXISTS "object_permission_id" TEXT;

-- AlterTable
ALTER TABLE "DeRouter_UserTable" ADD COLUMN IF NOT EXISTS "object_permission_id" TEXT;

-- AlterTable
ALTER TABLE "DeRouter_VerificationToken" ADD COLUMN IF NOT EXISTS "object_permission_id" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "DeRouter_ObjectPermissionTable" (
    "object_permission_id" TEXT NOT NULL,
    "mcp_servers" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "DeRouter_ObjectPermissionTable_pkey" PRIMARY KEY ("object_permission_id")
);

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DeRouter_OrganizationTable_object_permission_id_fkey') THEN
        ALTER TABLE "DeRouter_OrganizationTable" ADD CONSTRAINT "DeRouter_OrganizationTable_object_permission_id_fkey" FOREIGN KEY ("object_permission_id") REFERENCES "DeRouter_ObjectPermissionTable"("object_permission_id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DeRouter_TeamTable_object_permission_id_fkey') THEN
        ALTER TABLE "DeRouter_TeamTable" ADD CONSTRAINT "DeRouter_TeamTable_object_permission_id_fkey" FOREIGN KEY ("object_permission_id") REFERENCES "DeRouter_ObjectPermissionTable"("object_permission_id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DeRouter_UserTable_object_permission_id_fkey') THEN
        ALTER TABLE "DeRouter_UserTable" ADD CONSTRAINT "DeRouter_UserTable_object_permission_id_fkey" FOREIGN KEY ("object_permission_id") REFERENCES "DeRouter_ObjectPermissionTable"("object_permission_id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DeRouter_VerificationToken_object_permission_id_fkey') THEN
        ALTER TABLE "DeRouter_VerificationToken" ADD CONSTRAINT "DeRouter_VerificationToken_object_permission_id_fkey" FOREIGN KEY ("object_permission_id") REFERENCES "DeRouter_ObjectPermissionTable"("object_permission_id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

