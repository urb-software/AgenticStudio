-- Preview stop and reset: a state check that finds nothing running also records that the Preview
-- is gone, and at most one stop or data removal is requested or claimed per Project.
-- Rollback: DROP INDEX "preview_operations_one_active_change_per_project";
-- ALTER TABLE "preview_operations" DROP CONSTRAINT "preview_operations_preview_removed_check";
-- ALTER TABLE "preview_operations" ADD CONSTRAINT "preview_operations_preview_removed_check"
--     CHECK ("preview_removed" = false OR ("kind" = 'build' AND "status" = 'failed'));
-- (First set preview_removed = false on every succeeded state operation.)

-- Prisma cannot express CHECK constraints or partial indexes: changed by hand.
ALTER TABLE "preview_operations" DROP CONSTRAINT "preview_operations_preview_removed_check";
ALTER TABLE "preview_operations" ADD CONSTRAINT "preview_operations_preview_removed_check"
    CHECK ("preview_removed" = false
        OR ("kind" = 'build' AND "status" = 'failed')
        OR ("kind" = 'state' AND "status" = 'succeeded'));

-- At most one requested or claimed stop or data removal per Project: the backstop of the request check.
CREATE UNIQUE INDEX "preview_operations_one_active_change_per_project"
    ON "preview_operations" ("project_id")
    WHERE "kind" IN ('stop', 'remove_data') AND "status" IN ('requested', 'claimed');
