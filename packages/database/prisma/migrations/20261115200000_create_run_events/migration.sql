-- Live log of a Run (Issue #99): the stored events and the per-Run log cap accounting.
ALTER TABLE "runs" ADD COLUMN "log_bytes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "runs" ADD COLUMN "log_truncated" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "run_events" (
    "run_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL,
    "step_index" INTEGER NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "text" TEXT NOT NULL,
    "truncated" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "run_events_pkey" PRIMARY KEY ("run_id","seq")
);

-- AddForeignKey
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma cannot express CHECK constraints: added by hand. A migration that adds kinds
-- replaces this constraint.
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_kind_check"
    CHECK ("kind" IN ('message', 'command', 'output', 'step_started', 'step_finished', 'notice'));
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_seq_check"
    CHECK ("seq" >= 1 AND "step_index" >= 1);
ALTER TABLE "runs" ADD CONSTRAINT "runs_log_bytes_check"
    CHECK ("log_bytes" >= 0);
