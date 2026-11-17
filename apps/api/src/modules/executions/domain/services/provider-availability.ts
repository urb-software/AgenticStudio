import { PROVIDER_NAMES } from '@agentic-studio/contracts';
import { PROVIDERS, type Provider } from '../entities/run.js';
import { type RecordedWorkerStatus, WorkerStatus } from '../value-objects/worker-status.js';

/** Why a provider is unavailable; shown to the operator as is. */
export const PROVIDER_UNAVAILABLE_REASONS = {
  switchedOff: 'Switched off on the agent worker',
  noWorker: 'No agent worker is connected',
} as const;
/**
 * Studio's own reasons, or the reason the worker reported for a switched-on provider it cannot
 * run (Issue #105: e.g. an unsupported CLI version).
 */
export type ProviderUnavailableReason = string;

export interface ProviderAvailability {
  id: Provider;
  name: string;
  available: boolean;
  /** Set exactly when unavailable. */
  reason?: ProviderUnavailableReason;
}

/**
 * Which providers can take a Run, from the latest worker status. A status older than the
 * worker lease (`STUDIO_WORKER_LEASE_SECONDS`) counts as no worker connected. A switched-on
 * provider with a reason from the worker (Issue #105) is unavailable with that reason.
 */
export function providerAvailability(
  latest: RecordedWorkerStatus | undefined,
  now: Date,
  leaseSeconds: number,
): ProviderAvailability[] {
  const status = latest === undefined ? undefined : WorkerStatus.restore(latest);
  return PROVIDERS.map((id) => {
    const name = PROVIDER_NAMES[id];
    if (status === undefined || !status.isConnected(now, leaseSeconds)) {
      return { id, name, available: false, reason: PROVIDER_UNAVAILABLE_REASONS.noWorker };
    }
    if (!status.hasSwitchedOn(id)) {
      return { id, name, available: false, reason: PROVIDER_UNAVAILABLE_REASONS.switchedOff };
    }
    const workerReason = status.reasonFor(id);
    if (workerReason !== undefined) return { id, name, available: false, reason: workerReason };
    return { id, name, available: true };
  });
}

/** A Run cannot start: Studio knows its provider is unavailable. */
export class ProviderUnavailableError extends Error {
  constructor(
    readonly provider: Provider,
    readonly reason: ProviderUnavailableReason,
  ) {
    super(reason);
    this.name = 'ProviderUnavailableError';
  }
}
