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
