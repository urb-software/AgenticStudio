import type { RunEvent } from './run-event.js';

export const LOG_TRUNCATED_NOTICE =
  "log truncated: the Run's log reached its size limit; later output is not stored";

export interface LogCapState {
  bytes: number;
  truncated: boolean;
}

const utf8Length = (text: string) => Buffer.byteLength(text, 'utf8');

export class LogCap {
  private constructor(readonly state: LogCapState) {}

  static of(state: LogCapState): LogCap {
    return new LogCap({ ...state });
  }

  /** The first event that does not fit becomes one {@link LOG_TRUNCATED_NOTICE}; it and every later event are dropped. */
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
