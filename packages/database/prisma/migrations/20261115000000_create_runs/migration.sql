-- Issue #96: the `executions` module's Runs and Run steps. Additive: two new tables, nothing
-- existing changes. Rollback: drop both tables (no other table references them).

-- CreateTable
CREATE TABLE "runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "task" VARCHAR(20000) NOT NULL,
    "state" VARCHAR(32) NOT NULL,
    "start_commit" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "failure_code" VARCHAR(32),
    "failure_detail" VARCHAR(2000),
    "claimed_by" UUID,
    "heartbeat_at" TIMESTAMPTZ(6),

    CONSTRAINT "runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_steps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "index" INTEGER NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "result" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "run_steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "runs_created_at_id_idx" ON "runs"("created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "runs_project_id_created_at_id_idx" ON "runs"("project_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "runs_state_created_at_id_idx" ON "runs"("state", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "run_steps_run_id_index_key" ON "run_steps"("run_id", "index");

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Defence in depth on the state machine (the adapter writes only these combinations). Prisma
-- does not model CHECK constraints or partial indexes, so they live only here. Later stories
-- that add states, providers or codes replace these constraints.
ALTER TABLE "runs" ADD CONSTRAINT "runs_state_check"
    CHECK ("state" IN ('queued', 'preparing', 'running', 'waiting_for_operator', 'succeeded', 'failed', 'cancelled', 'timed_out'));
ALTER TABLE "runs" ADD CONSTRAINT "runs_provider_check"
    CHECK ("provider" IN ('claude_code', 'codex'));
ALTER TABLE "runs" ADD CONSTRAINT "runs_task_check"
    CHECK (char_length("task") >= 1);
ALTER TABLE "runs" ADD CONSTRAINT "runs_failure_code_check"
    CHECK ("failure_code" IN ('provider_disabled', 'preparation_failed', 'agent_failed', 'usage_limit', 'worker_lost', 'delivery_failed', 'unknown'));
ALTER TABLE "runs" ADD CONSTRAINT "runs_failure_when_failed_check"
    CHECK (("state" = 'failed') = ("failure_code" IS NOT NULL AND "failure_detail" IS NOT NULL));
-- A worker holds a Run exactly while it is preparing or running, with a heartbeat.
ALTER TABLE "runs" ADD CONSTRAINT "runs_claim_check"
    CHECK (("state" IN ('preparing', 'running')) = ("claimed_by" IS NOT NULL));
ALTER TABLE "runs" ADD CONSTRAINT "runs_heartbeat_check"
    CHECK (("claimed_by" IS NULL) = ("heartbeat_at" IS NULL));
-- Started once handed to a worker; finished exactly in a final state.
ALTER TABLE "runs" ADD CONSTRAINT "runs_started_check"
    CHECK ("state" IN ('queued', 'cancelled', 'timed_out') OR "started_at" IS NOT NULL);
ALTER TABLE "runs" ADD CONSTRAINT "runs_finished_check"
    CHECK (("state" IN ('succeeded', 'failed', 'cancelled', 'timed_out')) = ("finished_at" IS NOT NULL));
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_kind_check"
    CHECK ("kind" IN ('start', 'resume'));
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_index_check"
    CHECK ("index" >= 1);

-- At most one active Run per project (Issue #96): the claim enforces it under a lock, and this
-- index makes a second active Run of the same project impossible even if that logic breaks.
CREATE UNIQUE INDEX "runs_one_active_per_project_key" ON "runs"("project_id")
    WHERE "state" IN ('preparing', 'running', 'waiting_for_operator');
