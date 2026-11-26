-- The names of the skills a Run's agent had at start, recorded with the commit the Run already
-- records, and the fixed failure code skills_unusable. Every existing Run has none.
-- Rollback: ALTER TABLE "runs" DROP COLUMN "agent_skills"; then restore runs_failure_code_check
-- without 'skills_unusable' (no Run may hold that code by then).

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "agent_skills" TEXT[] DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "runs" DROP CONSTRAINT "runs_failure_code_check";
ALTER TABLE "runs" ADD CONSTRAINT "runs_failure_code_check"
    CHECK ("failure_code" IN ('provider_disabled', 'preparation_failed', 'agent_failed', 'usage_limit', 'worker_lost', 'delivery_failed', 'step_limit', 'agent_folder_unavailable', 'agent_folder_invalid', 'model_not_allowed', 'model_refused', 'skills_unusable', 'unknown'));
