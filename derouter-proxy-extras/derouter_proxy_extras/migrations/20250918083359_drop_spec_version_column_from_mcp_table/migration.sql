/*
  Warnings:

  - You are about to drop the column `spec_version` on the `DeRouter_MCPServerTable` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "DeRouter_MCPServerTable" DROP COLUMN IF EXISTS "spec_version";
