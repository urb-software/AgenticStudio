import { RunCancellation } from './run-cancellation.js';
import type { RunSweepFacts } from './run-sweep-facts.js';

/**
 * The store lists the waiting Runs (`listWaiting`, the state only) and cancels one only while it
 * still waits (`cancelUnheld`).
 */
export class LongWaitRule {
  private constructor(readonly now: Date) {}

  static at(now: Date): LongWaitRule {
    return new LongWaitRule(now);
  }

  candidate(run: Pick<RunSweepFacts, 'state'>): boolean {
    return run.state === 'waiting_for_operator';
  }

  selects(run: Pick<RunSweepFacts, 'state' | 'waitingSince' | 'limits'>): boolean {
    return this.cancellationFor(run) !== null;
  }

  cancellationFor(
    run: Pick<RunSweepFacts, 'state' | 'waitingSince' | 'limits'>,
  ): RunCancellation | null {
    if (run.state !== 'waiting_for_operator' || run.waitingSince === null) return null;
    // The waiting limit is Studio's own: the agent worker never enforces it.
    const limitMs = run.limits.waitingDays * 24 * 60 * 60 * 1000;
    if (this.now.getTime() - run.waitingSince.getTime() <= limitMs) return null;
    const days = run.limits.waitingDays;
    return RunCancellation.afterWaiting(days);
  }
}
