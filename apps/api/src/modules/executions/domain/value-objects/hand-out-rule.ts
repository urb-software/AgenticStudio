import type { RunState } from './run-state.js';
import type { HandOutView } from './hand-out-view.js';

/**
 * The store hands a Run out in one transaction under the claim lock, re-checking Runs another
 * transaction holds; `next` is the same rule in memory, which a test uses to prove the query
 * follows it.
 */
export class HandOutRule {
  static readonly PLACE_STATES = [
    'preparing',
    'running',
    'waiting_for_operator',
  ] as const satisfies readonly RunState[];

  static readonly MAX_PLACES = 2;

  private constructor(readonly workerId: string) {}

  static for(workerId: string): HandOutRule {
    return new HandOutRule(workerId);
  }

  /** The rule for counting the places Runs hold, which belong to no worker in particular. */
  static countingPlaces(): HandOutRule {
    return new HandOutRule('');
  }

  holdsPlace(
    run: Pick<HandOutView, 'state' | 'claimedBy' | 'sessionRef' | 'followUpQueued'>,
  ): boolean {
    return (
      (HandOutRule.PLACE_STATES as readonly string[]).includes(run.state) ||
      (run.state === 'failed' && run.claimedBy !== null) ||
      (run.state === 'queued' && run.sessionRef !== null && !run.followUpQueued)
    );
  }

  private readonly queueOrder = (a: HandOutView, b: HandOutView): number =>
    a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  /**
   * A Run with an agent session or a delivery retry goes only to the worker that last claimed it:
   * it alone has the Working copy.
   */
  takes(run: HandOutView): boolean {
    if (run.state === 'queued')
      return run.sessionRef === null || run.lastClaimedBy === this.workerId;
    return (
      run.state === 'failed' &&
      run.deliveryRequested &&
      run.claimedBy === null &&
      run.lastClaimedBy === this.workerId
    );
  }

  next<T extends HandOutView>(runs: readonly T[]): T | undefined {
    return [...runs].sort(this.queueOrder).find((candidate) => {
      if (!this.takes(candidate)) return false;
      const others = runs.filter((run) => run.id !== candidate.id && this.holdsPlace(run));
      return (
        others.length < HandOutRule.MAX_PLACES &&
        !others.some((other) => other.projectId === candidate.projectId)
      );
    });
  }
}
