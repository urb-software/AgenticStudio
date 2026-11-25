-- The Project's kind: 'code' (every existing Project) or 'definitions' (the Repository that holds
-- agent definitions; it accepts no Run, no Preview and no Environment file). At most one
-- definitions Project exists.
-- Rollback: DROP INDEX "projects_one_definitions_key"; ALTER TABLE "projects" DROP CONSTRAINT
-- "projects_kind_check"; ALTER TABLE "projects" DROP COLUMN "kind". Disconnect and delete the
-- definitions Project first, or it becomes an ordinary Project.

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "kind" VARCHAR(16) NOT NULL DEFAULT 'code';

-- Prisma cannot express CHECK constraints or partial indexes: added by hand.
ALTER TABLE "projects" ADD CONSTRAINT "projects_kind_check"
    CHECK ("kind" IN ('code', 'definitions'));

CREATE UNIQUE INDEX "projects_one_definitions_key" ON "projects" ("kind") WHERE "kind" = 'definitions';
