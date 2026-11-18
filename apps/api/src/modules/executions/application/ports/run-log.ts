import type { RunEvent } from '../../domain/value-objects/run-event.js';

export const RUN_LOG = Symbol('RUN_LOG');

/** The per-Run cap is applied atomically (`LogCap.plan`) against concurrent appends. */
export interface RunLog {
  /**
   * Events whose seq is already stored are ignored. Returns how many were stored, or `null` if
   * the worker does not hold the Run.
   */
  append(
    runId: string,
    workerId: string,
    events: readonly RunEvent[],
    maxBytes: number,
  ): Promise<number | null>;

  /** 0 when none. */
  lastSeq(runId: string): Promise<number>;

  listAfter(runId: string, after: number, limit: number): Promise<RunEvent[]>;
}
