import type { RunState } from './run-state.js';

/** What the hand-out rule reads of a Run (a flat record, as a snapshot or a stored row has it). */
export interface HandOutView {
  id: string;
  projectId: string;
  state: RunState;
  claimedBy: string | null;
  sessionRef: string | null;
  followUpQueued: boolean;
  deliveryRequested: boolean;
  lastClaimedBy: string | null;
  createdAt: Date;
}

/**
 * The hand-out rule (ADR 0002, Issues #96, #102, #103, #141, #169): which Run an agent worker is
 * handed when it asks for work, if any.
 *
 * - **Queue order:** the oldest first, by creation time and then id.
 * - **Which worker may take a Run:** a `queued` Run no worker has started, any worker; a `queued`
 *   Run that was answered or got a Follow-up (it has an agent session) and a `failed` Run whose
 *   delivery retry was requested and that nobody holds, only the worker that last claimed it, for
 *   it alone has the Working copy.
 * - **Places:** a Run holds a place while it is active (`preparing`, `running`, waiting for the
 *   operator), while a worker holds a `failed` Run for a delivery retry, and while an answered Run
 *   waits in the queue for its worker (a Run queued for a Follow-up holds none until it is
 *   claimed). A Run is handed out only if no other Run of its Project holds a place and fewer than
 *   {@link HandOutRule.MAX_PLACES} other Runs hold one across the server. A Run's own place does
 *   not count against it.
 *
 * The store hands the Run out in one atomic step under the claim lock, with the query the places
 * and the limit here supply. It waits for a Run another transaction holds and then re-checks it, so
 * a Run is never skipped for being briefly locked and the order stays strict; {@link HandOutRule.next} is the same rule over a set of Runs, which
 * a test uses to prove the query follows it.
 */
export class HandOutRule {
  /**
   * The states in which a Run holds a place, besides the held and the answered Runs below: an
   * agent worker or the operator holds the Run (they count against the concurrency limits).
   */
  static readonly PLACE_STATES = [
    'preparing',
    'running',
    'waiting_for_operator',
  ] as const satisfies readonly RunState[];

  /** At most this many Runs hold a place across the server (ADR 0002). */
  static readonly MAX_PLACES = 2;

  private constructor(readonly workerId: string) {}

  /** The rule for the agent worker that asks for work. */
  static for(workerId: string): HandOutRule {
    return new HandOutRule(workerId);
  }

  /** Whether the Run holds a place now: an active state, held for a retry, or answered and queued. */
  static holdsPlace(
    run: Pick<HandOutView, 'state' | 'claimedBy' | 'sessionRef' | 'followUpQueued'>,
  ): boolean {
    return (
      (HandOutRule.PLACE_STATES as readonly string[]).includes(run.state) ||
      (run.state === 'failed' && run.claimedBy !== null) ||
      (run.state === 'queued' && run.sessionRef !== null && !run.followUpQueued)
    );
  }

  /** The queue order: the oldest Run first, ties by id. */
  static readonly queueOrder = (a: HandOutView, b: HandOutView): number =>
    a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  /** Whether this worker may take the Run, whatever the places say. */
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

  /** The Run to hand out among `runs` (all Runs), or `undefined` when none is eligible. */
  next<T extends HandOutView>(runs: readonly T[]): T | undefined {
    return [...runs].sort(HandOutRule.queueOrder).find((candidate) => {
      if (!this.takes(candidate)) return false;
      const others = runs.filter((run) => run.id !== candidate.id && HandOutRule.holdsPlace(run));
      return (
        others.length < HandOutRule.MAX_PLACES &&
        !others.some((other) => other.projectId === candidate.projectId)
      );
    });
  }
}
