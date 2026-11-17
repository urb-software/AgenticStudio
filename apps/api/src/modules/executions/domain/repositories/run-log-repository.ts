import type { RunEvent } from '../value-objects/run-event.js';

/** DI token for the {@link RunLogRepository} adapter. */
export const RUN_LOG_REPOSITORY = Symbol('RUN_LOG_REPOSITORY');

/**
 * The store of Run logs (Issue #99): each Run's events by sequence number, with the per-Run
 * cap applied atomically (`planLogAppend`) against concurrent appends.
 */
export interface RunLogRepository {
  /**
   * Stores `events` (redacted and cut, in seq order) for a Run that `workerId` holds
   * (`preparing` or `running`). Events whose seq is already stored are ignored, so a re-sent
   * batch changes nothing; the rest go through the cap. Returns how many events were stored,
   * or `null` if the worker does not hold the Run.
   */
  append(
    runId: string,
    workerId: string,
    events: readonly RunEvent[],
    maxBytes: number,
  ): Promise<number | null>;

  /** The highest seq stored for the Run, 0 when none (Issue #103: a resume continues after it). */
  lastSeq(runId: string): Promise<number>;

  /** Up to `limit` of the Run's events with a seq above `after`, in seq order. */
  listAfter(runId: string, after: number, limit: number): Promise<RunEvent[]>;
}
