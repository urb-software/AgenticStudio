import type { Provider } from './provider.js';
import type { ProviderUnavailableReason } from './provider-unavailable-reason.js';

export interface ProviderAvailability {
  id: Provider;
  name: string;
  available: boolean;
  reason?: ProviderUnavailableReason;
}
