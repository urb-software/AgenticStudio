-- The fixed failure codes gain model_not_allowed and model_refused.
ALTER TABLE "runs" DROP CONSTRAINT "runs_failure_code_check";
ALTER TABLE "runs" ADD CONSTRAINT "runs_failure_code_check"
    CHECK ("failure_code" IN ('provider_disabled', 'preparation_failed', 'agent_failed', 'usage_limit', 'worker_lost', 'delivery_failed', 'step_limit', 'agent_folder_unavailable', 'agent_folder_invalid', 'model_not_allowed', 'model_refused', 'unknown'));
