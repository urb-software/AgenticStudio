import type { Provider } from '@agentic-studio/agent-definitions';

export const PROVIDER_AVAILABILITIES = Symbol('PROVIDER_AVAILABILITIES');

/** Whether a Run can use a Provider now. */
export interface ProviderAvailabilityView {
  id: Provider;
  name: string;
  available: boolean;
  /** Why it is not available, as shown to the operator; absent when it is. */
  reason?: string;
}

export interface ProviderAvailabilities {
  /** Every Provider with its availability, from the agent workers' last reports. */
  list(): Promise<ProviderAvailabilityView[]>;
}
