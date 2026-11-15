-- Review round 2 of #121 (Issue #100). A cancel that arrives while a Run is being delivered
-- keeps what was delivered: a cancelled Run may record the delivery `none` or `delivered` with
-- its pull request. Studio's step clock stops when a Run step's result is reported, so
-- step_started_at is no longer required while running. Rollback: restore the two constraints
-- (only possible once no cancelled Run records a delivery).

ALTER TABLE "runs" DROP CONSTRAINT "runs_delivery_check";
ALTER TABLE "runs" ADD CONSTRAINT "runs_delivery_check"
    CHECK ("delivery" IS NULL
        OR ("delivery" IN ('none', 'delivered') AND "state" IN ('succeeded', 'cancelled'))
        OR ("delivery" = 'failed' AND "state" = 'failed' AND "failure_code" = 'delivery_failed'));
ALTER TABLE "runs" DROP CONSTRAINT "runs_step_started_check";
