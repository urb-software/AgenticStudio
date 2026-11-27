-- A Run may be started with a Workflow: the Run records the Workflow's name, commit and items, and
-- each of its Phases records the item it came from, its kind and its state. A Run started with an
-- agent has none of the Workflow columns and exactly one Phase with no item. A Project may name a
-- Workflow as its default instead of an agent. Additive: nothing is dropped.

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "default_workflow" VARCHAR(64);

ALTER TABLE "projects" ADD CONSTRAINT "projects_default_check"
    CHECK ("default_agent" IS NULL OR "default_workflow" IS NULL);

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "workflow_name" VARCHAR(64),
ADD COLUMN     "workflow_commit" VARCHAR(64),
ADD COLUMN     "workflow_items" JSONB,
ADD COLUMN     "phase_pending" BOOLEAN NOT NULL DEFAULT false;

-- Prisma cannot express CHECK constraints: added by hand.
ALTER TABLE "runs" ADD CONSTRAINT "runs_workflow_check" CHECK (
    ("workflow_name" IS NULL) = ("workflow_commit" IS NULL)
    AND ("workflow_name" IS NULL) = ("workflow_items" IS NULL)
    AND (NOT "phase_pending" OR "workflow_name" IS NOT NULL)
);

-- AlterTable
ALTER TABLE "run_phases" ADD COLUMN     "item_id" VARCHAR(64),
ADD COLUMN     "kind" VARCHAR(16) NOT NULL DEFAULT 'work',
ADD COLUMN     "state" VARCHAR(16) NOT NULL DEFAULT 'pending',
ADD COLUMN     "summary" TEXT;

ALTER TABLE "run_phases" ADD CONSTRAINT "run_phases_kind_state_check" CHECK (
    "kind" IN ('work')
    AND "state" IN ('pending', 'running', 'done', 'failed')
);

-- A Run that exists already has one Phase: its state follows the Run's.
UPDATE "run_phases" SET "state" = CASE "runs"."state"
        WHEN 'succeeded' THEN 'done'
        WHEN 'failed' THEN 'failed'
        WHEN 'cancelled' THEN 'failed'
        WHEN 'timed_out' THEN 'failed'
        WHEN 'queued' THEN CASE WHEN "runs"."has_session" THEN 'running' ELSE 'pending' END
        ELSE 'running'
    END
FROM "runs"
WHERE "runs"."id" = "run_phases"."run_id";

-- A Run between two Phases is queued and holds its place like an answered Run does.
DROP INDEX "runs_one_active_per_project_key";
CREATE UNIQUE INDEX "runs_one_active_per_project_key" ON "runs"("project_id")
    WHERE "state" IN ('preparing', 'running', 'waiting_for_operator')
       OR ("state" = 'queued' AND ("has_session" OR "phase_pending") AND NOT "follow_up_queued");
