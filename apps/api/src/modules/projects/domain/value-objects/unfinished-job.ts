/**
 * Why the job of a clone or fetch ended without finishing on its own: the processor's own
 * error, or the reason the queue aborted it. It has the shape of the queue's failure report,
 * which the job's entry point passes on; the domain and the application name no queue.
 */
export type UnfinishedJob =
  | { reason: 'error'; error: unknown }
  | { reason: 'cancelled' | 'timeout' | 'stalled' | 'shutdown' };
