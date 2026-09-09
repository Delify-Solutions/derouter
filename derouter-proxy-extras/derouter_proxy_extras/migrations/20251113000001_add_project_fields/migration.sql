-- AlterTable: Add new fields to DeRouter_ProjectTable
ALTER TABLE "DeRouter_ProjectTable" ADD COLUMN IF NOT EXISTS "description" TEXT;
ALTER TABLE "DeRouter_ProjectTable" ADD COLUMN IF NOT EXISTS "model_rpm_limit" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "DeRouter_ProjectTable" ADD COLUMN IF NOT EXISTS "model_tpm_limit" JSONB NOT NULL DEFAULT '{}';

