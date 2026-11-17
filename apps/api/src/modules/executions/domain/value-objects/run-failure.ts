/** Why a Run failed: the fixed codes of Issue #96. */
export const RUN_FAILURE_CODES = [
  'provider_disabled',
  'preparation_failed',
  'agent_failed',
  'usage_limit',
  'worker_lost',
  'delivery_failed',
  'step_limit',
  'unknown',
] as const;
export type RunFailureCode = (typeof RUN_FAILURE_CODES)[number];

/** How a Run failed, set exactly when its state is `failed`. */
export interface RunFailure {
  code: RunFailureCode;
  /** A short explanation; never a secret. */
  detail: string;
}
