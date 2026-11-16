import type { Run } from '../entities/run.js';
import { providerAvailability, type RecordedWorkerStatus } from './provider-availability.js';

/**
 * What Studio knows about the agent worker for a Run's Follow-up (Issue #141): whether the
 * worker that holds the Run's Working copy has reported within the lease, and whether the Run's
 * Provider is available on the connected worker (the same rule as starting a Run, Issue #101).
 */
export function followUpContext(
  run: Pick<Run, 'provider' | 'lastClaimedBy'>,
  workers: {
    latest(): RecordedWorkerStatus | undefined;
    lastSeen(workerId: string): Date | undefined;
  },
  now: Date,
  leaseSeconds: number,
): { workerAvailable: boolean; providerAvailable: boolean } {
  const seen = run.lastClaimedBy === null ? undefined : workers.lastSeen(run.lastClaimedBy);
  const workerAvailable =
    seen !== undefined && now.getTime() - seen.getTime() <= leaseSeconds * 1000;
  const provider = providerAvailability(workers.latest(), now, leaseSeconds).find(
    (candidate) => candidate.id === run.provider,
  );
  return { workerAvailable, providerAvailable: provider?.available === true };
}
