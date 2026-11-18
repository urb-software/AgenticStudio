/**
 * The worker protocol's and the HTTP contract's enums are pinned to this list by tests; the database CHECK
 * constraints are written from it.
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

/** Queued ones count too: they are on their way, only not started yet. */
export const UNDER_WAY_RUN_STATES = [
  'queued',
  'preparing',
  'running',
] as const satisfies readonly RunState[];

/** Held by an agent worker (it sends heartbeats); the lost-worker sweep's scope. */
export const CLAIMED_RUN_STATES = ['preparing', 'running'] as const satisfies readonly RunState[];
export type ClaimedRunState = (typeof CLAIMED_RUN_STATES)[number];

export const FINAL_RUN_STATES = [
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
] as const satisfies readonly RunState[];
export type FinalRunState = (typeof FINAL_RUN_STATES)[number];

export function isRunState(value: string): value is RunState {
  return (RUN_STATES as readonly string[]).includes(value);
}

export function isFinalRunState(value: string): value is FinalRunState {
  return (FINAL_RUN_STATES as readonly string[]).includes(value);
}

export function isClaimedRunState(value: string): value is ClaimedRunState {
  return (CLAIMED_RUN_STATES as readonly string[]).includes(value);
}
