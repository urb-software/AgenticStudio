-- Issue #103: an agent's question pauses a Run, the operator's answer resumes the same session.
-- Additive: a new column and table, and the one-active-Run-per-project index also covers an
-- answered Run waiting in the queue for the worker that holds its Working copy. Rollback: drop
-- run_messages and session_ref, and restore runs_one_active_per_project_key as created in
-- 20261115000000_create_runs (only once no answered Run is queued).

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "session_ref" VARCHAR(256);

-- CreateTable
CREATE TABLE "run_messages" (
    "run_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "text" TEXT NOT NULL,
    "options" JSONB,
    "recommendation" TEXT,
    "at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "run_messages_pkey" PRIMARY KEY ("run_id","seq")
);

-- AddForeignKey
ALTER TABLE "run_messages" ADD CONSTRAINT "run_messages_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma cannot express CHECK constraints or partial indexes: added by hand.
ALTER TABLE "run_messages" ADD CONSTRAINT "run_messages_kind_check"
    CHECK ("kind" IN ('question', 'answer'));
ALTER TABLE "run_messages" ADD CONSTRAINT "run_messages_seq_check" CHECK ("seq" >= 1);
-- Only a question offers options or recommends one.
ALTER TABLE "run_messages" ADD CONSTRAINT "run_messages_question_fields_check"
    CHECK ("kind" = 'question' OR ("options" IS NULL AND "recommendation" IS NULL));

-- An answered Run (queued with a session reference) keeps its project's place until the worker
-- that holds its Working copy resumes it: the claim enforces it under a lock, and the index
-- makes a second active Run of the same project impossible even if that logic breaks.
DROP INDEX "runs_one_active_per_project_key";
CREATE UNIQUE INDEX "runs_one_active_per_project_key" ON "runs"("project_id")
    WHERE "state" IN ('preparing', 'running', 'waiting_for_operator')
       OR ("state" = 'queued' AND "session_ref" IS NOT NULL);
