import type { RunEvent } from './run-event.js';

/** The notice stored once when a Run's log reaches its cap. */
export const LOG_TRUNCATED_NOTICE =
  "log truncated: the Run's log reached its size limit; later output is not stored";

/** How much of the per-Run cap a Run's stored log uses, and whether it was reached. */
export interface LogCapState {
  bytes: number;
  truncated: boolean;
}

const utf8Length = (text: string) => Buffer.byteLength(text, 'utf8');

/**
 * The per-Run log cap: how much of the cap a Run's stored log uses, and which of the new events
 * to store.
 */
export class LogCap {
  private constructor(readonly state: LogCapState) {}

  /** The cap as a Run's log stands now (`bytes` used, whether the cap was reached). */
  static of(state: LogCapState): LogCap {
    return new LogCap({ ...state });
  }

  /**
   * Which of `events` (new, in seq order) to store, and the state afterwards. Event texts count
   * in UTF-8 bytes against `maxBytes`. The first event that does not fit is replaced by one
   * {@link LOG_TRUNCATED_NOTICE} (same seq and step); it and every later event are dropped, and
   * nothing more is stored for the Run.
   */
  plan(events: readonly RunEvent[], maxBytes: number): { store: RunEvent[]; state: LogCapState } {
    const { state } = this;
    if (state.truncated) return { store: [], state };
    const store: RunEvent[] = [];
    let bytes = state.bytes;
    for (const event of events) {
      const size = utf8Length(event.text);
      if (bytes + size > maxBytes) {
        store.push({
          seq: event.seq,
          at: event.at,
          stepIndex: event.stepIndex,
          kind: 'notice',
          text: LOG_TRUNCATED_NOTICE,
          truncated: false,
        });
        return { store, state: { bytes, truncated: true } };
      }
      bytes += size;
      store.push(event);
    }
    return { store, state: { bytes, truncated: false } };
  }
}
