-- Issue #147: the operator can ask for a Run's branch to be brought up to date with the
-- integration branch. It is a Follow-up (a `follow_up` message) whose source is `bring_up_to_date`
-- (the `source` column and its CHECK are from 20261117200000_pull_request_checks); where the merge
-- started and the integration branch commit that was merged are recorded on it. The note is
-- optional, so the text of such a Follow-up may be empty.
-- Rollback (only once no Run has such a Follow-up): drop the three columns and restore
-- run_messages_source_check as created in 20261117200000_pull_request_checks.

-- AlterTable
ALTER TABLE "run_messages" ADD COLUMN     "merged_commit" VARCHAR(64),
ADD COLUMN     "update_base" VARCHAR(64),
ADD COLUMN     "update_tip" VARCHAR(64);

-- Only a Follow-up has a source, and only a known one; the commits of a bring-up request come with
-- that source alone.
ALTER TABLE "run_messages" DROP CONSTRAINT "run_messages_source_check";
ALTER TABLE "run_messages" ADD CONSTRAINT "run_messages_source_check"
    CHECK (("source" IS NULL OR ("kind" = 'follow_up' AND "source" IN ('pull_request_checks', 'bring_up_to_date')))
       AND (("merged_commit" IS NULL AND "update_base" IS NULL AND "update_tip" IS NULL)
            OR "source" = 'bring_up_to_date'));
