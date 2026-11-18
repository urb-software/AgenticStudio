import type { RunSweepFacts } from './run-sweep-facts.js';

/**
 * The store's sweep (`timeOutOverdueSteps`) is one set-wide statement; `selects` is the same
 * selection over one Run.
 */
export class OverdueStepRule {
  /**
   * The agent worker stops a step at `stepMinutes`; Studio ends the Run itself
   * only this much later.
   */
  static readonly GRACE_MINUTES = 5;

  private constructor(
    readonly now: Date,
    readonly graceMinutes: number,
  ) {}

  static at(now: Date, graceMinutes: number = OverdueStepRule.GRACE_MINUTES): OverdueStepRule {
    return new OverdueStepRule(now, graceMinutes);
  }

  selects(run: Pick<RunSweepFacts, 'state' | 'stepStartedAt' | 'limits'>): boolean {
    if (run.state !== 'running' || run.stepStartedAt === null) return false;
    const allowedMs = (run.limits.stepMinutes + this.graceMinutes) * 60_000;
    return this.now.getTime() - run.stepStartedAt.getTime() > allowedMs;
  }
}
