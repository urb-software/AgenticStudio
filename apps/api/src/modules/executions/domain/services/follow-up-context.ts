import { followUpEligibility, type FollowUpEligibility, type Run } from '../entities/run.js';
import { providerAvailability } from './provider-availability.js';
import { type RecordedWorkerStatus, WorkerStatus } from '../value-objects/worker-status.js';
import { keepUntil, type RetentionPolicy, retentionFactsOf } from './retention.js';

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
  const workerAvailable = WorkerStatus.isWithinLease(seen, now, leaseSeconds);
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
  return latest !== undefined && WorkerStatus.restore(latest).isConnected(now, leaseSeconds);
}

/**
 * A Run's Follow-up eligibility with, when the Run is open to one, until when (Issue #143), or
 * that its removal is pending: its date passed, or the per-Project limit removes it, and the
 * agent worker's next hourly sweep takes the Working copy.
 */
export type FollowUpView = FollowUpEligibility & { openUntil?: Date; removalPending?: true };

/**
 * Until when a Run stays open to Follow-ups, from its retention (Issue #143), when it is open to
 * one: it can take one now, or only waits for its worker or Provider to be available. Not once
 * the Working copy is gone, the pull request is over, or the Run is not finished.
 */
function openness(
  run: Run,
  eligibility: FollowUpEligibility,
  policy: RetentionPolicy,
  overLimit: boolean,
  now: Date,
): { openUntil: Date } | { removalPending: true } | undefined {
  const open =
    eligibility.allowed ||
    eligibility.reason === 'worker_unavailable' ||
    eligibility.reason === 'provider_unavailable';
  if (!open) return undefined;
  const until = keepUntil(retentionFactsOf(run), policy);
  if (until === null) return undefined;
  return overLimit || until.getTime() <= now.getTime()
    ? { removalPending: true }
    : { openUntil: until };
}

/**
 * What the single-Run answers (the Run page, the refresh and the Follow-up command) add to a Run:
 * whether it can take a Follow-up now and until when it stays open to one, and whether any agent
 * worker is connected (Issues #141, #142, #143). `overLimit`: the per-Project limit removes it.
 */
export function runView(
  run: Run,
  workers: Parameters<typeof followUpContext>[1],
  now: Date,
  leaseSeconds: number,
  retention: RetentionPolicy,
  overLimit = false,
): { run: Run; followUp: FollowUpView; workerConnected: boolean } {
  const eligibility = followUpEligibility(run, followUpContext(run, workers, now, leaseSeconds));
  return {
    run,
    followUp: { ...eligibility, ...openness(run, eligibility, retention, overLimit, now) },
    workerConnected: anyWorkerConnected(workers, now, leaseSeconds),
  };
}
