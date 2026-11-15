-- Issue #98: a Run records its Repository's remote URL (the agent worker fetches the start
-- commit from it) and the latest Working copy state the agent worker reported. Additive.
-- Rollback: drop the four columns and the CHECK constraint.

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "commits" JSONB,
ADD COLUMN     "has_uncommitted_changes" BOOLEAN,
ADD COLUMN     "remote_url" VARCHAR(2048),
ADD COLUMN     "run_branch" VARCHAR(255);

-- Existing Runs take their project's current remote URL. A Run whose project has no Repository
-- any more gets an empty URL: it can still be read, and if it is ever claimed its preparation
-- fails (the worker protocol refuses an empty remote URL).
UPDATE "runs" SET "remote_url" = r."url"
    FROM "repositories" r WHERE r."project_id" = "runs"."project_id";
UPDATE "runs" SET "remote_url" = '' WHERE "remote_url" IS NULL;
ALTER TABLE "runs" ALTER COLUMN "remote_url" SET NOT NULL;

-- The Working copy state is reported as a whole: all three columns are set, or none is.
ALTER TABLE "runs" ADD CONSTRAINT "runs_working_copy_check"
    CHECK (("run_branch" IS NULL) = ("commits" IS NULL)
       AND ("run_branch" IS NULL) = ("has_uncommitted_changes" IS NULL));
