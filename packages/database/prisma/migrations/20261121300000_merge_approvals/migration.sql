-- The Merge approval: what the operator approved when pressing "Approve and merge", stored before
-- the merge and kept whatever came of it. One additive table; a partial unique index lets one
-- merge at a time be pending for a Run.
-- Rollback: drop table merge_approvals.

-- CreateTable
CREATE TABLE "merge_approvals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "approved_at" TIMESTAMPTZ(6) NOT NULL,
    "approved_by" VARCHAR(16) NOT NULL,
    "commit" VARCHAR(64) NOT NULL,
    "integration_branch" VARCHAR(255) NOT NULL,
    "method" VARCHAR(16) NOT NULL,
    "checks_seen" JSONB NOT NULL,
    "result" VARCHAR(16) NOT NULL,
    "refusal_code" VARCHAR(32),
    "refusal_reason" VARCHAR(500),
    "merged_commit" VARCHAR(64),
    "completed_at" TIMESTAMPTZ(6),
    "merge_requested_at" TIMESTAMPTZ(6),
    "clone_fetch_started_at" TIMESTAMPTZ(6),

    CONSTRAINT "merge_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "merge_approvals_run_id_approved_at_idx" ON "merge_approvals"("run_id", "approved_at");

-- AddForeignKey
ALTER TABLE "merge_approvals" ADD CONSTRAINT "merge_approvals_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "merge_approvals" ADD CONSTRAINT "merge_approvals_result_check"
    CHECK ("result" IN ('pending', 'carried_out', 'not_carried_out'));

ALTER TABLE "merge_approvals" ADD CONSTRAINT "merge_approvals_method_check"
    CHECK ("method" IN ('squash'));

ALTER TABLE "merge_approvals" ADD CONSTRAINT "merge_approvals_checks_seen_check"
    CHECK (jsonb_typeof("checks_seen") = 'array');

-- A pending approval is unfinished, a carried out one names the merged commit, and a not carried
-- out one says why.
ALTER TABLE "merge_approvals" ADD CONSTRAINT "merge_approvals_outcome_check"
    CHECK (
      ("result" = 'pending' AND "completed_at" IS NULL AND "merged_commit" IS NULL
         AND "refusal_code" IS NULL)
      OR ("result" = 'carried_out' AND "completed_at" IS NOT NULL AND "merged_commit" IS NOT NULL
         AND "refusal_code" IS NULL)
      OR ("result" = 'not_carried_out' AND "completed_at" IS NOT NULL AND "merged_commit" IS NULL
         AND "refusal_code" IS NOT NULL)
    );

-- Two simultaneous merges of a Run are one: the second insert is refused while one is pending.
CREATE UNIQUE INDEX "merge_approvals_one_pending_per_run_key"
    ON "merge_approvals"("run_id") WHERE "result" = 'pending';
