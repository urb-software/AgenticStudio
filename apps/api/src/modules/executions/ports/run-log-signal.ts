/** DI token of the {@link RunLogSignal}. */
export const RUN_LOG_SIGNAL = Symbol('RUN_LOG_SIGNAL');

/**
 * Wakes live log streams (Issue #99): a Run's log or state changed, so a stream reads the
 * stored log again. In process, as Studio runs one API instance (like the job queue's
 * consumers); a missed signal costs latency only, because the stored log is the record.
 */
export interface RunLogSignal {
  notify(runId: string): void;
  /** Calls `listener` on every notify for `runId` until the returned function is called. */
  subscribe(runId: string, listener: () => void): () => void;
}
