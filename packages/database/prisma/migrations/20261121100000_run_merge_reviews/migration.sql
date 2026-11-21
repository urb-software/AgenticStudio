-- The merge review Studio computes for a Run (what the Integration branch would gain
-- from the Run's branch). One additive table, one row per Run, replaced by each new review.
-- Rollback: drop table run_merge_reviews.

-- CreateTable
CREATE TABLE "run_merge_reviews" (
    "run_id" UUID NOT NULL,
    "state" VARCHAR(16) NOT NULL,
    "run_commit" VARCHAR(64),
    "integration_commit" VARCHAR(64),
    "files" JSONB NOT NULL,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "failure" VARCHAR(2000),
    "requested_at" TIMESTAMPTZ(6) NOT NULL,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "run_merge_reviews_pkey" PRIMARY KEY ("run_id")
);

-- AddForeignKey
ALTER TABLE "run_merge_reviews" ADD CONSTRAINT "run_merge_reviews_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "run_merge_reviews" ADD CONSTRAINT "run_merge_reviews_state_check"
    CHECK ("state" IN ('preparing', 'ready', 'failed'));

ALTER TABLE "run_merge_reviews" ADD CONSTRAINT "run_merge_reviews_files_check"
    CHECK (jsonb_typeof("files") = 'array');

-- A ready review is of two known commits and says when it finished; a preparing one is unfinished.
ALTER TABLE "run_merge_reviews" ADD CONSTRAINT "run_merge_reviews_ready_check"
    CHECK (
      ("state" = 'ready' AND "run_commit" IS NOT NULL AND "integration_commit" IS NOT NULL
         AND "completed_at" IS NOT NULL)
      OR ("state" = 'preparing' AND "completed_at" IS NULL)
      OR ("state" = 'failed' AND "completed_at" IS NOT NULL)
    );
