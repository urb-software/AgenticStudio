-- A Run's agent, its session and its Run-step allowance move from the Run to a Phase of the Run,
-- and each Run step belongs to a Phase. Every existing Run gets one Phase (position 0) with the
-- values it has today; a Run has no other Phase yet. ONE-WAY DOOR: the dropped runs columns are
-- not kept, so a rollback needs a backup taken before this migration.
-- Not carried over: the CHECK that the agent's provider equals the Run's provider (it spans two
-- tables; the Run's own validation holds it) and, in runs_follow_up_check, steps_before_part >= 0
-- (now a CHECK on run_phases).

-- CreateTable
CREATE TABLE "run_phases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "agent_name" VARCHAR(64) NOT NULL,
    "agent_source" VARCHAR(16) NOT NULL,
    "agent_commit" VARCHAR(64),
    "agent_provider" VARCHAR(32) NOT NULL,
    "agent_model" VARCHAR(64) NOT NULL,
    "agent_instructions" TEXT NOT NULL,
    "agent_skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "session_ref" VARCHAR(256),
    "steps_before_part" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "run_phases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "run_phases_run_id_position_key" ON "run_phases"("run_id", "position");

-- AddForeignKey
ALTER TABLE "run_phases" ADD CONSTRAINT "run_phases_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma cannot express CHECK constraints: added by hand.
ALTER TABLE "run_phases" ADD CONSTRAINT "run_phases_agent_check" CHECK (
    "position" >= 0
    AND "steps_before_part" >= 0
    AND "agent_source" IN ('built_in', 'definitions')
    AND ("agent_source" = 'definitions') = ("agent_commit" IS NOT NULL)
);

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "current_phase" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "has_session" BOOLEAN NOT NULL DEFAULT false;

INSERT INTO "run_phases" ("run_id", "position", "agent_name", "agent_source", "agent_commit",
    "agent_provider", "agent_model", "agent_instructions", "agent_skills", "session_ref",
    "steps_before_part")
SELECT "id", 0, "agent_name", "agent_source", "agent_commit", "agent_provider", "agent_model",
    "agent_instructions", COALESCE("agent_skills", ARRAY[]::TEXT[]), "session_ref",
    "steps_before_part"
FROM "runs";

UPDATE "runs" SET "has_session" = ("session_ref" IS NOT NULL);

-- AlterTable
ALTER TABLE "run_steps" ADD COLUMN     "phase_id" UUID;

UPDATE "run_steps" SET "phase_id" = "run_phases"."id"
FROM "run_phases"
WHERE "run_phases"."run_id" = "run_steps"."run_id" AND "run_phases"."position" = 0;

ALTER TABLE "run_steps" ALTER COLUMN "phase_id" SET NOT NULL;

-- CreateIndex
CREATE INDEX "run_steps_phase_id_idx" ON "run_steps"("phase_id");

-- AddForeignKey
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_phase_id_fkey" FOREIGN KEY ("phase_id") REFERENCES "run_phases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The one-active-Run-per-project index reads has_session in place of session_ref.
DROP INDEX "runs_one_active_per_project_key";
ALTER TABLE "runs" DROP CONSTRAINT "runs_agent_check";
ALTER TABLE "runs" DROP CONSTRAINT "runs_follow_up_check";

-- AlterTable
ALTER TABLE "runs" DROP COLUMN "agent_commit",
DROP COLUMN "agent_instructions",
DROP COLUMN "agent_model",
DROP COLUMN "agent_name",
DROP COLUMN "agent_provider",
DROP COLUMN "agent_skills",
DROP COLUMN "agent_source",
DROP COLUMN "session_ref",
DROP COLUMN "steps_before_part";

ALTER TABLE "runs" ADD CONSTRAINT "runs_follow_up_check"
    CHECK ("follow_up_count" >= 0 AND "limit_max_total_steps" >= 1
       AND (NOT "follow_up_queued" OR ("state" = 'queued' AND "follow_up_count" >= 1)));
ALTER TABLE "runs" ADD CONSTRAINT "runs_current_phase_check" CHECK ("current_phase" >= 0);

CREATE UNIQUE INDEX "runs_one_active_per_project_key" ON "runs"("project_id")
    WHERE "state" IN ('preparing', 'running', 'waiting_for_operator')
       OR ("state" = 'queued' AND "has_session" AND NOT "follow_up_queued");
