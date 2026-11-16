import type { RunOutput } from '../../../platform/api';

type RunState = RunOutput['state'];

/**
 * The Run state groups of the web app, defined once (Issue #115). They follow the API's
 * state machine: these are presentation groups for polling, counts and the log, and the API
 * alone decides a Run's state.
 */

/**
 * Active, i.e. under way without the operator: queued ones count too (on their way, only not
 * started yet). The API's `UNDER_WAY_RUN_STATES`; not its `ACTIVE_RUN_STATES`, which are the
 * states that hold a concurrency place.
 */
export const UNDER_WAY_STATES: readonly RunState[] = ['queued', 'preparing', 'running'];

/** Waiting for the operator: the Run moves on only when they act. */
export const WAITING_STATES: readonly RunState[] = ['waiting_for_operator'];

/** Over: the Run can be run again, and its log is complete. */
export const FINAL_STATES: readonly RunState[] = ['succeeded', 'failed', 'cancelled', 'timed_out'];
