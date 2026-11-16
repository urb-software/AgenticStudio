-- Issue #146: the pull request's Review comments as input for a Follow-up. All additive: a third
-- lookup kind with the two columns it needs (what to load, and since when), the table of loaded
-- comment sets (at most one per Run, replaced by each load, removed when a Follow-up prepared from
-- it is sent) and what a Follow-up prepared from them records (how many comments, whose).
-- Rollback (only once no load is wanted): drop table run_review_comment_sets, the source_count and
-- source_authors columns of run_messages and the scope and since columns of run_lookups; restore
-- run_messages_source_check as created in 20261117300000_bring_up_to_date and run_lookups_kind_check to
-- ('pull_request_state', 'failing_check_logs') after deleting the review_comments rows.

-- AlterTable
ALTER TABLE "run_lookups" ADD COLUMN     "scope" VARCHAR(24),
ADD COLUMN     "since" TIMESTAMPTZ(6);

ALTER TABLE "run_lookups" DROP CONSTRAINT "run_lookups_kind_check";
ALTER TABLE "run_lookups" ADD CONSTRAINT "run_lookups_kind_check"
    CHECK ("kind" IN ('pull_request_state', 'failing_check_logs', 'review_comments'));

-- Only a review_comments lookup says what to load; "since" only goes with the first scope.
ALTER TABLE "run_lookups" ADD CONSTRAINT "run_lookups_scope_check"
    CHECK (
      ("kind" = 'review_comments' AND "scope" IN ('since_last_result', 'unresolved')
         AND ("since" IS NULL OR "scope" = 'since_last_result'))
      OR ("kind" <> 'review_comments' AND "scope" IS NULL AND "since" IS NULL)
    );

-- AlterTable
ALTER TABLE "run_messages" ADD COLUMN     "source_authors" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "source_count" INTEGER;

ALTER TABLE "run_messages" DROP CONSTRAINT "run_messages_source_check";
ALTER TABLE "run_messages" ADD CONSTRAINT "run_messages_source_check"
    CHECK (("source" IS NULL OR ("kind" = 'follow_up'
             AND "source" IN ('pull_request_checks', 'bring_up_to_date', 'review_comments')))
       AND (("merged_commit" IS NULL AND "update_base" IS NULL AND "update_tip" IS NULL)
            OR "source" = 'bring_up_to_date'));

-- The comment count and authors belong to a Follow-up prepared from review comments only.
ALTER TABLE "run_messages" ADD CONSTRAINT "run_messages_source_detail_check"
    CHECK (
      ("source" = 'review_comments' AND "source_count" BETWEEN 1 AND 100
         AND cardinality("source_authors") BETWEEN 1 AND 20)
      OR (("source" IS NULL OR "source" <> 'review_comments') AND "source_count" IS NULL
         AND cardinality("source_authors") = 0)
    );

-- CreateTable
CREATE TABLE "run_review_comment_sets" (
    "run_id" UUID NOT NULL,
    "scope" VARCHAR(24) NOT NULL,
    "comments" JSONB NOT NULL,
    "truncated" BOOLEAN NOT NULL,
    "loaded_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "run_review_comment_sets_pkey" PRIMARY KEY ("run_id")
);

-- AddForeignKey
ALTER TABLE "run_review_comment_sets" ADD CONSTRAINT "run_review_comment_sets_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "run_review_comment_sets" ADD CONSTRAINT "run_review_comment_sets_check"
    CHECK ("scope" IN ('since_last_result', 'unresolved') AND jsonb_typeof("comments") = 'array');
