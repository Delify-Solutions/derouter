-- AlterTable
ALTER TABLE "DeRouter_EndUserTable" ADD COLUMN IF NOT EXISTS "object_permission_id" TEXT;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DeRouter_EndUserTable_object_permission_id_fkey') THEN
        ALTER TABLE "DeRouter_EndUserTable" ADD CONSTRAINT "DeRouter_EndUserTable_object_permission_id_fkey" FOREIGN KEY ("object_permission_id") REFERENCES "DeRouter_ObjectPermissionTable"("object_permission_id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

