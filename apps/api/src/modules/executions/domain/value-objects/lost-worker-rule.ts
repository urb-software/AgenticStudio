import { RunFailure } from './run-failure.js';
import type { RunSweepFacts } from './run-sweep-facts.js';

/**
 * The store's sweep (`failStaleClaims`) is one set-wide statement with the cut-off and the failures
 * this rule supplies; `selects` is the same selection over one Run, which a test uses to prove the
 * statement follows it.
 */
export class LostWorkerRule {
  private constructor(
    readonly staleBefore: Date,
    readonly failure: RunFailure,
    readonly deliveryFailure: RunFailure,
  ) {}

  static at(now: Date, leaseSeconds: number): LostWorkerRule {
    return new LostWorkerRule(
      new Date(now.getTime() - leaseSeconds * 1000),
      RunFailure.restore({
        code: 'worker_lost',
        detail: `The agent worker sent no heartbeat for ${leaseSeconds} seconds.`,
      }),
      // A delivery retry whose worker was lost stays a failed delivery, so it can be retried.
      RunFailure.restore({
        code: 'delivery_failed',
        detail:
          `The agent worker sent no heartbeat for ${leaseSeconds} seconds while it retried the ` +
          'delivery. Retry the delivery.',
      }),
    );
  }

  selects(run: Pick<RunSweepFacts, 'claimedBy' | 'heartbeatAt'>): boolean {
    return run.claimedBy !== null && run.heartbeatAt !== null && run.heartbeatAt < this.staleBefore;
  }

  resultFor(run: Pick<RunSweepFacts, 'state'>): { failure: RunFailure; retryEnds: boolean } {
    return run.state === 'failed'
      ? { failure: this.deliveryFailure, retryEnds: true }
      : { failure: this.failure, retryEnds: false };
  }
}
