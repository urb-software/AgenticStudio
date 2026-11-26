export const RUN_FAILURE_CODES = [
  'provider_disabled',
  'preparation_failed',
  'agent_failed',
  'usage_limit',
  'worker_lost',
  'delivery_failed',
  'step_limit',
  'agent_folder_unavailable',
  'agent_folder_invalid',
  'model_not_allowed',
  'model_refused',
  'skills_unusable',
  'unknown',
] as const;
export type RunFailureCode = (typeof RUN_FAILURE_CODES)[number];
