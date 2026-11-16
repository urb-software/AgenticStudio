-- Review S1 of #152: the page-open throttle and the daily refresh of a Run's pull request state
-- count from the last attempt (a lookup that failed leaves pr_refreshed_at alone), so a failing
-- lookup is not repeated on every page open or every hourly pass.
-- Rollback: drop the column.

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "pr_last_attempt_at" TIMESTAMPTZ(6);
