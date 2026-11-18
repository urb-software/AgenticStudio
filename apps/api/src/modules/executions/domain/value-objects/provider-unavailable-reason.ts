/** Shown to the operator as is. */
export const PROVIDER_UNAVAILABLE_REASONS = {
  switchedOff: 'Switched off on the agent worker',
  noWorker: 'No agent worker is connected',
} as const;
export type ProviderUnavailableReason = string;
