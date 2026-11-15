-- Review of #121 (Issue #100): idempotent worker reports, Studio's step time-limit backstop and
-- lease renewal at most once per lease period. Additive. Rollback: drop the two columns, the
-- CHECK constraint and the run_lease_renewals table.

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "released_by" UUID,
ADD COLUMN     "step_started_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "run_lease_renewals" (
    "id" SMALLINT NOT NULL,
    "renewed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "run_lease_renewals_pkey" PRIMARY KEY ("id")
);

-- A running Run's step started when it went to running; existing running Runs take their start.
UPDATE "runs" SET "step_started_at" = COALESCE("started_at", now()) WHERE "state" = 'running';
ALTER TABLE "runs" ADD CONSTRAINT "runs_step_started_check"
    CHECK ("state" <> 'running' OR "step_started_at" IS NOT NULL);
-- One row only.
ALTER TABLE "run_lease_renewals" ADD CONSTRAINT "run_lease_renewals_single_check" CHECK ("id" = 1);
