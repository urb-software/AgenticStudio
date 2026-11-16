-- Issue #147: the operator can ask for a Run's branch to be brought up to date with the
-- integration branch. It is a Follow-up (a `follow_up` message) marked with its source; the
-- integration branch commit that was merged is recorded on it once the worker reports it. The
-- note is optional, so the text of such a Follow-up may be empty.
-- Rollback (only once no Run has such a Follow-up): drop the four columns and the new CHECK
-- constraint.

-- AlterTable
ALTER TABLE "run_messages" ADD COLUMN     "merged_commit" VARCHAR(64),
ADD COLUMN     "source" VARCHAR(24),
ADD COLUMN     "update_base" VARCHAR(64),
ADD COLUMN     "update_tip" VARCHAR(64);

-- Only a Follow-up has a source, and only a source of bring_up_to_date; a merged commit comes
-- with that source alone.
ALTER TABLE "run_messages" ADD CONSTRAINT "run_messages_source_check"
    CHECK (("source" IS NULL OR ("kind" = 'follow_up' AND "source" = 'bring_up_to_date'))
       AND ("merged_commit" IS NULL OR "source" IS NOT NULL)
       AND (("update_base" IS NULL AND "update_tip" IS NULL) OR "source" IS NOT NULL));
