/**
 * Studio redacts and caps the text before storing it. The worker protocol's and the HTTP contract's
 * lists of kinds are pinned to {@link RUN_EVENT_KINDS} by a test; the database CHECK constraint is
 * written from it.
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
