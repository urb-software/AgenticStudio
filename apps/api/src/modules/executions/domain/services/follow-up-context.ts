import { followUpEligibility, type FollowUpEligibility, type Run } from '../entities/run.js';
import type { RetentionPolicy } from '../../ports/retention-policy.js';
import { providerAvailability, type RecordedWorkerStatus } from './provider-availability.js';
import { keepUntil } from './retention.js';

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

/** A Run's Follow-up eligibility with, when the Run is open to one, until when (Issue #143). */
export type FollowUpView = FollowUpEligibility & { openUntil?: Date };

/**
 * Until when a Run stays open to Follow-ups, from its retention (Issue #143), when it is open to
 * one: it can take one now, or only waits for the worker or its Provider to be available. Not
 * once the Working copy is gone, the pull request is over, or the Run is not finished.
 */
function openUntil(run: Run, eligibility: FollowUpEligibility, policy: RetentionPolicy) {
  const open =
    eligibility.allowed ||
    eligibility.reason === 'worker_unavailable' ||
    eligibility.reason === 'provider_unavailable';
  if (!open) return undefined;
  return (
    keepUntil(
      {
        state: run.state,
        finishedAt: run.finishedAt,
        hasPullRequest: run.pullRequest !== null,
        pullRequestState: run.pullRequestStatus.state,
        pullRequestEndedAt: run.pullRequestStatus.endedAt,
        lastActivityAt: run.lastActivityAt,
      },
      policy,
    ) ?? undefined
  );
}

/**
 * What the single-Run answers (the Run page, the refresh and the Follow-up command) add to a Run:
 * whether it can take a Follow-up now and until when it stays open to one, and whether any agent
 * worker is connected (Issues #141, #142, #143).
 */
export function runView(
  run: Run,
  workers: Parameters<typeof followUpContext>[1],
  now: Date,
  leaseSeconds: number,
  retention: RetentionPolicy,
): { run: Run; followUp: FollowUpView; workerConnected: boolean } {
  const eligibility = followUpEligibility(run, followUpContext(run, workers, now, leaseSeconds));
  const until = openUntil(run, eligibility, retention);
  return {
    run,
    followUp: until === undefined ? eligibility : { ...eligibility, openUntil: until },
    workerConnected: anyWorkerConnected(workers, now, leaseSeconds),
  };
}
