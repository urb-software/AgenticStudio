/**
 * A Run event (Issue #99): one entry of a Run's log, the Run's durable record of what the
 * agent did. The worker numbers events per Run (`seq`, from 1); Studio redacts and caps the
 * text before storing it. The worker protocol's and the HTTP contract's lists of kinds are
 * pinned to {@link RUN_EVENT_KINDS} by a test; the database CHECK constraint is written from it.
 */

export const RUN_EVENT_KINDS = [
  'message',
  'command',
  'output',
  'step_started',
  'step_finished',
  'notice',
] as const;
export type RunEventKind = (typeof RUN_EVENT_KINDS)[number];

export interface RunEvent {
  seq: number;
  at: Date;
  stepIndex: number;
  kind: RunEventKind;
  text: string;
  /** The text was cut to the per-event cap. */
  truncated: boolean;
}

/** An event about to be stored (already redacted and cut). */
export type NewRunEvent = RunEvent;

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
 * The per-Run log cap: which of `events` (new, in seq order) to store given the Run's
 * `state`, and the state afterwards. Event texts count in UTF-8 bytes against `maxBytes`. The
 * first event that does not fit is replaced by one {@link LOG_TRUNCATED_NOTICE} (same seq and
 * step); it and every later event are dropped, and nothing more is stored for the Run.
 */
export function planLogAppend(
  state: LogCapState,
  events: readonly NewRunEvent[],
  maxBytes: number,
): { store: NewRunEvent[]; state: LogCapState } {
  if (state.truncated) return { store: [], state };
  const store: NewRunEvent[] = [];
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
