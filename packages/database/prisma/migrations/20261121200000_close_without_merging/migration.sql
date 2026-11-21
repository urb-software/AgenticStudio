-- Close a Run without merging: when Studio closed the pull request, when it deleted the Run's own
-- branch on the Git host (a merge reuses the two run_branch_* columns), why a deletion failed,
-- and the claim that lets one request at a time act. All additive and nullable.
-- Rollback: drop the constraint and the four columns of runs.

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "close_claimed_at" TIMESTAMPTZ(6),
ADD COLUMN     "pull_request_closed_from_studio_at" TIMESTAMPTZ(6),
ADD COLUMN     "run_branch_deleted_at" TIMESTAMPTZ(6),
ADD COLUMN     "run_branch_deletion_failure" VARCHAR(500);

-- A close from Studio only happens to a pull request that has ended.
ALTER TABLE "runs" ADD CONSTRAINT "runs_close_from_studio_check"
    CHECK ("pull_request_closed_from_studio_at" IS NULL OR "pr_state" IN ('merged', 'closed', 'missing'));
