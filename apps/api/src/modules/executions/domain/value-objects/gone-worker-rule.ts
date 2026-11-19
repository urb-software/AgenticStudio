import { RunFailure } from './run-failure.js';
import type { RunSweepFacts } from './run-sweep-facts.js';

/**
 * A pending delivery retry or resume can only be taken by the worker that last claimed the Run;
 * when that worker has not reported for longer than the lease, it fails. The Run gives one up
 * only while it is pending (`abandonDeliveryRetry`, `abandonResume`).
 */
export class GoneWorkerRule {
  private constructor(
    readonly seenBefore: Date,
    readonly deliveryRetryFailure: RunFailure,
    readonly resumeFailure: RunFailure,
  ) {}

  static at(now: Date, leaseSeconds: number): GoneWorkerRule {
    return new GoneWorkerRule(
      new Date(now.getTime() - leaseSeconds * 1000),
      RunFailure.of(
        'delivery_failed',
        `Working copy no longer exists (agent worker gone): the agent worker that started this ` +
          `run has not reported for more than ${leaseSeconds} seconds.`,
      ),
      RunFailure.of(
        'preparation_failed',
        `Working copy no longer exists (agent worker gone) — run again: the agent worker that ` +
          `started this run has not reported for more than ${leaseSeconds} seconds.`,
      ),
    );
  }

  isGone(seen: Date): boolean {
    return seen < this.seenBefore;
  }

  pendingDeliveryRetry(
    run: Pick<RunSweepFacts, 'state' | 'deliveryRequested' | 'claimedBy'>,
  ): boolean {
    return run.state === 'failed' && run.deliveryRequested && run.claimedBy === null;
  }

  pendingResume(run: Pick<RunSweepFacts, 'state' | 'sessionRef'>): boolean {
    return run.state === 'queued' && run.sessionRef !== null;
  }
}
