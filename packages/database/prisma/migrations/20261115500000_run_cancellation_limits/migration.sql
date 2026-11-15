-- Issue #100: cancelling a Run and its limits. Additive: new columns, and the failure-code and
-- state constraints are replaced to take the new code. Rollback: drop the seven columns and
-- the new constraints, and restore runs_failure_code_check without 'step_limit' (only possible
-- once no Run carries it).

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "cancel_reason" VARCHAR(500),
ADD COLUMN     "cancel_requested_at" TIMESTAMPTZ(6),
ADD COLUMN     "cancelled_by" VARCHAR(16),
ADD COLUMN     "limit_max_steps" INTEGER,
ADD COLUMN     "limit_step_minutes" INTEGER,
ADD COLUMN     "limit_waiting_days" INTEGER,
ADD COLUMN     "waiting_since" TIMESTAMPTZ(6);

-- Existing Runs take the default limits. Nothing could cancel a Run before this migration, so
-- a cancelled Run, if any, was changed by hand: it is recorded as cancelled by the system.
-- A Run already waiting starts its waiting period now, so none is cancelled the moment the
-- long-wait sweep first runs.
UPDATE "runs" SET "limit_step_minutes" = 60, "limit_max_steps" = 10, "limit_waiting_days" = 14;
UPDATE "runs" SET "cancelled_by" = 'system', "cancel_reason" = 'Cancelled before cancellation reasons were recorded.'
    WHERE "state" = 'cancelled';
UPDATE "runs" SET "waiting_since" = now() WHERE "state" = 'waiting_for_operator';
ALTER TABLE "runs" ALTER COLUMN "limit_step_minutes" SET NOT NULL,
ALTER COLUMN "limit_max_steps" SET NOT NULL,
ALTER COLUMN "limit_waiting_days" SET NOT NULL;

-- The fixed failure codes gain step_limit.
ALTER TABLE "runs" DROP CONSTRAINT "runs_failure_code_check";
ALTER TABLE "runs" ADD CONSTRAINT "runs_failure_code_check"
    CHECK ("failure_code" IN ('provider_disabled', 'preparation_failed', 'agent_failed', 'usage_limit', 'worker_lost', 'delivery_failed', 'step_limit', 'unknown'));
-- A cancellation (who and why) exactly when cancelled.
ALTER TABLE "runs" ADD CONSTRAINT "runs_cancellation_check"
    CHECK (("state" = 'cancelled') = ("cancelled_by" IS NOT NULL)
       AND ("cancelled_by" IS NULL) = ("cancel_reason" IS NULL)
       AND ("cancelled_by" IS NULL OR "cancelled_by" IN ('operator', 'system')));
-- A cancel request is recorded only once a worker holds the Run (it stays as history).
ALTER TABLE "runs" ADD CONSTRAINT "runs_cancel_request_check"
    CHECK ("cancel_requested_at" IS NULL OR "state" NOT IN ('queued', 'waiting_for_operator'));
ALTER TABLE "runs" ADD CONSTRAINT "runs_waiting_since_check"
    CHECK (("state" = 'waiting_for_operator') = ("waiting_since" IS NOT NULL));
ALTER TABLE "runs" ADD CONSTRAINT "runs_limits_check"
    CHECK ("limit_step_minutes" >= 1 AND "limit_max_steps" >= 1 AND "limit_waiting_days" >= 1);
