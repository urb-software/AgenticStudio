-- The agent a Run was started with, copied onto the Run at start and never changed, and the
-- Project's default agent. Every existing Run becomes a Run of its Provider's built-in Default
-- agent: no commit, the CLI's default model, no instructions.
-- Rollback: ALTER TABLE "runs" DROP CONSTRAINT "runs_agent_check", DROP COLUMN "agent_name",
-- DROP COLUMN "agent_source", DROP COLUMN "agent_commit", DROP COLUMN "agent_provider",
-- DROP COLUMN "agent_model", DROP COLUMN "agent_instructions"; ALTER TABLE "projects" DROP COLUMN
-- "default_agent".

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "default_agent" VARCHAR(64);

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "agent_commit" VARCHAR(64),
ADD COLUMN     "agent_instructions" TEXT,
ADD COLUMN     "agent_model" VARCHAR(64),
ADD COLUMN     "agent_name" VARCHAR(64),
ADD COLUMN     "agent_provider" VARCHAR(32),
ADD COLUMN     "agent_source" VARCHAR(16);

UPDATE "runs"
SET "agent_name" = 'default-' || replace("provider", '_', '-'),
    "agent_source" = 'built_in',
    "agent_provider" = "provider",
    "agent_model" = 'default',
    "agent_instructions" = '';

ALTER TABLE "runs" ALTER COLUMN "agent_instructions" SET NOT NULL,
ALTER COLUMN "agent_model" SET NOT NULL,
ALTER COLUMN "agent_name" SET NOT NULL,
ALTER COLUMN "agent_provider" SET NOT NULL,
ALTER COLUMN "agent_source" SET NOT NULL;

-- Prisma cannot express CHECK constraints: added by hand.
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_check" CHECK (
    "agent_source" IN ('built_in', 'definitions')
    AND ("agent_source" = 'definitions') = ("agent_commit" IS NOT NULL)
    AND "agent_provider" = "provider"
);
