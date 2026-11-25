-- Preview rebuild after a merge through Studio: the Run that started a build, and the rebuild a
-- merge asked for that the Preview has not carried out yet (one per Project).
-- Rollback: DROP TABLE "preview_merge_rebuilds";
-- ALTER TABLE "preview_operations" DROP CONSTRAINT "preview_operations_started_by_run_check";
-- ALTER TABLE "preview_operations" DROP COLUMN "started_by_run_id".

-- AlterTable
ALTER TABLE "preview_operations" ADD COLUMN "started_by_run_id" UUID;

-- CreateTable
CREATE TABLE "preview_merge_rebuilds" (
    "project_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "merged_commit" VARCHAR(64) NOT NULL,
    "merged_at" TIMESTAMPTZ(6) NOT NULL,
    "fetch_started_at" TIMESTAMPTZ(6) NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,
    "failure" VARCHAR(2000),
    "failed_at" TIMESTAMPTZ(6),

    CONSTRAINT "preview_merge_rebuilds_pkey" PRIMARY KEY ("project_id")
);

-- AddForeignKey
ALTER TABLE "preview_merge_rebuilds" ADD CONSTRAINT "preview_merge_rebuilds_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma cannot express CHECK constraints: added by hand.
ALTER TABLE "preview_operations" ADD CONSTRAINT "preview_operations_started_by_run_check"
    CHECK ("started_by_run_id" IS NULL OR "kind" = 'build');

ALTER TABLE "preview_merge_rebuilds" ADD CONSTRAINT "preview_merge_rebuilds_failure_check"
    CHECK (("failure" IS NULL) = ("failed_at" IS NULL));
