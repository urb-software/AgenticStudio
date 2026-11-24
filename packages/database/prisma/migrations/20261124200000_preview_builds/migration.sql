-- Preview builds: whether a failed build removed the running Preview, a lookup index for the
-- newest operation of a kind, and one active build per Project.
-- Rollback: DROP INDEX "preview_operations_one_active_build_per_project";
-- DROP INDEX "preview_operations_project_kind_finished_at_idx";
-- ALTER TABLE "preview_operations" DROP CONSTRAINT "preview_operations_preview_removed_check";
-- ALTER TABLE "preview_operations" DROP COLUMN "preview_removed".

-- AlterTable
ALTER TABLE "preview_operations" ADD COLUMN "preview_removed" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "preview_operations_project_kind_finished_at_idx"
    ON "preview_operations"("project_id", "kind", "finished_at");

-- Prisma cannot express CHECK constraints or partial indexes: added by hand.
ALTER TABLE "preview_operations" ADD CONSTRAINT "preview_operations_preview_removed_check"
    CHECK ("preview_removed" = false OR ("kind" = 'build' AND "status" = 'failed'));

-- At most one requested or claimed build per Project: the backstop of the request check.
CREATE UNIQUE INDEX "preview_operations_one_active_build_per_project"
    ON "preview_operations" ("project_id")
    WHERE "kind" = 'build' AND "status" IN ('requested', 'claimed');
