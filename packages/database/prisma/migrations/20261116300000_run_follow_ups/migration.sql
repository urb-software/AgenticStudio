-- Issue #141: a Follow-up reopens a finished Run: the same agent session continues in the same
-- Working copy and delivers to the same pull request. Additive columns; the pull request may now
-- stay on a Run that is queued, running or ended otherwise after a Follow-up (it is the Run's one
-- pull request), and a Run queued for a Follow-up holds no place until it is claimed.
-- Rollback (only once no Run has a Follow-up): drop the six columns and the new CHECK
-- constraints, restore run_messages_kind_check, runs_pull_request_check and
-- runs_one_active_per_project_key as created in 20261115800000_run_questions and
-- 20261115300000_run_delivery.

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "follow_up_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "follow_up_queued" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "limit_max_total_steps" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN     "pushed_commit" VARCHAR(64),
ADD COLUMN     "steps_before_part" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "working_copy_removed_at" TIMESTAMPTZ(6);

-- Prisma cannot express CHECK constraints or partial indexes: added by hand.
ALTER TABLE "runs" ADD CONSTRAINT "runs_follow_up_check"
    CHECK ("follow_up_count" >= 0 AND "steps_before_part" >= 0 AND "limit_max_total_steps" >= 1
       AND (NOT "follow_up_queued" OR ("state" = 'queued' AND "follow_up_count" >= 1)));

-- The Run's one pull request stays recorded after a Follow-up reopens the Run; a delivered Run
-- still always has it (replaces the constraint of 20261115300000_run_delivery).
ALTER TABLE "runs" DROP CONSTRAINT "runs_pull_request_check";
ALTER TABLE "runs" ADD CONSTRAINT "runs_pull_request_check"
    CHECK (("pull_request_url" IS NULL) = ("pull_request_number" IS NULL)
       AND ("delivery" IS DISTINCT FROM 'delivered' OR "pull_request_url" IS NOT NULL));

ALTER TABLE "run_messages" DROP CONSTRAINT "run_messages_kind_check";
ALTER TABLE "run_messages" ADD CONSTRAINT "run_messages_kind_check"
    CHECK ("kind" IN ('question', 'answer', 'follow_up'));

-- A Run queued for a Follow-up waits for a free place like any queued Run: it does not hold
-- its project's place (an answered Run, queued with a session reference, still does).
DROP INDEX "runs_one_active_per_project_key";
CREATE UNIQUE INDEX "runs_one_active_per_project_key" ON "runs"("project_id")
    WHERE "state" IN ('preparing', 'running', 'waiting_for_operator')
       OR ("state" = 'queued' AND "session_ref" IS NOT NULL AND NOT "follow_up_queued");
