/**
 * The states of a Run (Issue #96). The worker protocol's enums (`@agentic-studio/contracts`)
 * and the HTTP contract's are pinned to this list by tests; the database CHECK constraints are
 * written from it. Which transition each state allows is owned by `RunLifecycle`.
 */
export const RUN_STATES = [
  'queued',
  'preparing',
  'running',
  'waiting_for_operator',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
] as const;
export type RunState = (typeof RUN_STATES)[number];

/**
 * States in which a Run is under way without the operator (Issue #115): queued ones count too,
 * they are on their way, only not started yet. The run indicator's "running".
 */
export const UNDER_WAY_RUN_STATES = [
  'queued',
  'preparing',
  'running',
] as const satisfies readonly RunState[];

/** States an agent worker holds the Run in (it sends heartbeats); the lost-worker sweep's scope. */
export const CLAIMED_RUN_STATES = ['preparing', 'running'] as const satisfies readonly RunState[];
export type ClaimedRunState = (typeof CLAIMED_RUN_STATES)[number];

/** Final states: terminal, the Run is over. */
export const FINAL_RUN_STATES = [
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
] as const satisfies readonly RunState[];
export type FinalRunState = (typeof FINAL_RUN_STATES)[number];

/** Whether `value` is one of the {@link RUN_STATES}. */
export function isRunState(value: string): value is RunState {
  return (RUN_STATES as readonly string[]).includes(value);
}

/** Whether `value` is a final state of a Run (one of the {@link FINAL_RUN_STATES}). */
export function isFinalRunState(value: string): value is FinalRunState {
  return (FINAL_RUN_STATES as readonly string[]).includes(value);
}

/** Whether `value` is a state an agent worker holds a Run in (one of the {@link CLAIMED_RUN_STATES}). */
export function isClaimedRunState(value: string): value is ClaimedRunState {
  return (CLAIMED_RUN_STATES as readonly string[]).includes(value);
}
