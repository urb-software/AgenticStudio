import { followUpEligibility, type FollowUpEligibility, type Run } from '../entities/run.js';
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

/**
 * Whether any agent worker has reported within the lease (Issue #142): lookups need no Working
 * copy, so any connected worker can carry one out.
 */
export function anyWorkerConnected(
  workers: { latest(): RecordedWorkerStatus | undefined },
  now: Date,
  leaseSeconds: number,
): boolean {
  const latest = workers.latest();
  return latest !== undefined && now.getTime() - latest.reportedAt.getTime() <= leaseSeconds * 1000;
}

/**
 * What the single-Run answers (the Run page, the refresh and the Follow-up command) add to a Run:
 * whether it can take a Follow-up now, and whether any agent worker is connected (Issues #141,
 * #142).
 */
export function runView(
  run: Run,
  workers: Parameters<typeof followUpContext>[1],
  now: Date,
  leaseSeconds: number,
): { run: Run; followUp: FollowUpEligibility; workerConnected: boolean } {
  return {
    run,
    followUp: followUpEligibility(run, followUpContext(run, workers, now, leaseSeconds)),
    workerConnected: anyWorkerConnected(workers, now, leaseSeconds),
  };
}
