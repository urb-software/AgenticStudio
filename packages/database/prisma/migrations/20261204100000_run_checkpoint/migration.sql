-- A Run of a Workflow may wait at a Checkpoint: it is waiting_for_operator with the place of the
-- Checkpoint among the recorded items. The operator's comment on "Continue" is kept with the Phase
-- it reaches, and a Run whose Workflow ended at a Checkpoint is queued only to deliver what exists.
-- Additive: nothing is dropped, so it can be rolled back by dropping the columns.

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "checkpoint_item" INTEGER,
ADD COLUMN     "workflow_ended" BOOLEAN NOT NULL DEFAULT false;

-- Prisma cannot express CHECK constraints: added by hand.
ALTER TABLE "runs" ADD CONSTRAINT "runs_checkpoint_check" CHECK (
    ("checkpoint_item" IS NULL
        OR ("checkpoint_item" >= 0
            AND "state" = 'waiting_for_operator'
            AND "workflow_name" IS NOT NULL))
    AND (NOT "workflow_ended" OR "workflow_name" IS NOT NULL)
);

-- AlterTable
ALTER TABLE "run_phases" ADD COLUMN     "checkpoint_comment" TEXT;
