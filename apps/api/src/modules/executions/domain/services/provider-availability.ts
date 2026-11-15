import { PROVIDERS, type Provider } from '../entities/run.js';

/** How the reporting agent worker carries out Runs (Issue #101). */
export type WorkerRunnerMode = 'fake' | 'cli';

/**
 * The latest status an agent worker reported (Issue #101): its runner mode and which providers
 * its own configuration enables. Studio keeps it in memory only; the switches themselves never
 * leave the worker's configuration, and the worker's own check stays authoritative.
 */
export interface WorkerStatus {
  workerId: string;
  runner: WorkerRunnerMode;
  providers: Readonly<Record<Provider, boolean>>;
  reportedAt: Date;
}

export const PROVIDER_NAMES: Readonly<Record<Provider, string>> = {
  claude_code: 'Claude Code',
  codex: 'Codex',
};

/** Why a provider is unavailable; shown to the operator as is. */
export const PROVIDER_UNAVAILABLE_REASONS = {
  switchedOff: 'Switched off on the agent worker',
  noWorker: 'No agent worker is connected',
} as const;
export type ProviderUnavailableReason =
  (typeof PROVIDER_UNAVAILABLE_REASONS)[keyof typeof PROVIDER_UNAVAILABLE_REASONS];

export interface ProviderAvailability {
  id: Provider;
  name: string;
  available: boolean;
  /** Set exactly when unavailable. */
  reason?: ProviderUnavailableReason;
}

/**
 * Which providers can take a Run, from the latest worker status. A status older than the
 * worker lease (`STUDIO_WORKER_LEASE_SECONDS`) counts as no worker connected.
 */
export function providerAvailability(
  latest: WorkerStatus | undefined,
  now: Date,
  leaseSeconds: number,
): ProviderAvailability[] {
  const connected =
    latest !== undefined && now.getTime() - latest.reportedAt.getTime() <= leaseSeconds * 1000;
  return PROVIDERS.map((id) => {
    const name = PROVIDER_NAMES[id];
    if (!connected)
      return { id, name, available: false, reason: PROVIDER_UNAVAILABLE_REASONS.noWorker };
    if (latest.providers[id] !== true) {
      return { id, name, available: false, reason: PROVIDER_UNAVAILABLE_REASONS.switchedOff };
    }
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
