-- Issue #143: Working copy retention follows the Run's pull request. A Run's last activity (a Run
-- step, an Answer or a Follow-up) and when its pull request ended (merged, closed or not found)
-- are what Studio computes the retention from. Also, one stored pushed commit (review N2 of
-- #141): runs.pushed_commit stays, run_diff_states.pushed_commit goes.
-- Rollback: drop the two runs columns and add run_diff_states.pushed_commit again (nullable).

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "last_activity_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
ADD COLUMN     "pr_ended_at" TIMESTAMPTZ(6);

-- Existing Runs: active when they last moved; a pull request already over ended when it was read.
UPDATE "runs" SET "last_activity_at" = COALESCE("finished_at", "started_at", "created_at");
UPDATE "runs" SET "pr_ended_at" = COALESCE("pr_refreshed_at", "finished_at", "created_at")
WHERE "pr_state" IN ('merged', 'closed', 'missing');

-- Keep the pushed commit a diff state knew when the Run itself has none recorded.
UPDATE "runs" AS r SET "pushed_commit" = d."pushed_commit"
FROM "run_diff_states" AS d
WHERE d."run_id" = r."id" AND d."pushed_commit" IS NOT NULL AND r."pushed_commit" IS NULL;

-- Dropping the column drops the constraint that names it: the other ids keep theirs.
ALTER TABLE "run_diff_states" DROP COLUMN "pushed_commit";
ALTER TABLE "run_diff_states" ADD CONSTRAINT "run_diff_states_ids_check" CHECK (
    "result_tree" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
    AND "result_commit" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
    AND "previous_tree" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
    AND "previous_commit" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
);

-- Prisma cannot express CHECK constraints: added by hand. A pull request end is recorded only for
-- an ended state.
ALTER TABLE "runs" ADD CONSTRAINT "runs_pr_ended_check"
    CHECK ("pr_ended_at" IS NULL OR "pr_state" IN ('merged', 'closed', 'missing'));
