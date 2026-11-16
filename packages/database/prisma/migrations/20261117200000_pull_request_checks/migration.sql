-- Issue #145: the Pull request checks of a Run's pull request, and the Follow-up Studio prepares
-- from the failing ones. All additive: three nullable columns on runs (the checks as the last
-- state lookup read them, and whether a preparation of failing checks is under way or failed),
-- one nullable column on run_messages (what a Follow-up was prepared from), the table of
-- prepared Follow-ups (at most one per Run, replaced by each preparation, removed when sent or
-- discarded) and a second lookup kind.
-- Rollback (only once no preparation is wanted): drop table run_prepared_follow_ups, the
-- run_messages.source column and the three pr_* columns of runs, and restore
-- run_lookups_kind_check to ('pull_request_state') after deleting failing_check_logs rows.

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "pr_checks" JSONB,
ADD COLUMN     "pr_prepare_error" VARCHAR(500),
ADD COLUMN     "pr_prepare_requested_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "run_messages" ADD COLUMN     "source" VARCHAR(32);

-- Only a Follow-up has a source, and only a known one.
ALTER TABLE "run_messages" ADD CONSTRAINT "run_messages_source_check"
    CHECK ("source" IS NULL OR ("kind" = 'follow_up' AND "source" IN ('pull_request_checks')));

-- CreateTable
CREATE TABLE "run_prepared_follow_ups" (
    "run_id" UUID NOT NULL,
    "source" VARCHAR(32) NOT NULL,
    "text" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "run_prepared_follow_ups_pkey" PRIMARY KEY ("run_id")
);

-- AddForeignKey
ALTER TABLE "run_prepared_follow_ups" ADD CONSTRAINT "run_prepared_follow_ups_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "run_prepared_follow_ups" ADD CONSTRAINT "run_prepared_follow_ups_check"
    CHECK ("source" IN ('pull_request_checks') AND char_length("text") BETWEEN 1 AND 10000);

-- The second lookup kind (the first constraint is from 20261116800000_pull_request_state).
ALTER TABLE "run_lookups" DROP CONSTRAINT "run_lookups_kind_check";
ALTER TABLE "run_lookups" ADD CONSTRAINT "run_lookups_kind_check"
    CHECK ("kind" IN ('pull_request_state', 'failing_check_logs'));
