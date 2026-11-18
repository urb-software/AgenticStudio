export const RUN_LOG_SIGNAL = Symbol('RUN_LOG_SIGNAL');

/** In process: a missed signal costs latency only, because the stored log is the record. */
export interface RunLogSignal {
  notify(runId: string): void;
  subscribe(runId: string, listener: () => void): () => void;
}
