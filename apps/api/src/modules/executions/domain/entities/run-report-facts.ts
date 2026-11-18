import type { RunDeliveryOutcome } from '../value-objects/run-delivery.js';
import type { RunFailure } from '../value-objects/run-failure.js';
import type { RunState } from '../value-objects/run-state.js';
import type { RunWorkingCopy } from '../value-objects/run-working-copy.js';

/**
 * What an agent worker reports about a change of a Run's state (Issues #96, #102, #105, #147):
 * the state it reached, with how it ended and what it knows of the Working copy.
 */
export interface RunStateReport {
  /** One of the states a worker reports (the shared contract restricts it). */
  state: RunState;
  /** Exactly when `state` is `failed`. */
  failure: RunFailure | null;
  /** A failed Run's Working copy state, when the worker could read it (Issue #98). */
  workingCopy?: RunWorkingCopy | null;
  /** With `succeeded`: how the Run was delivered (Issue #102). */
  delivery?: RunDeliveryOutcome | null;
  /** With `failed` / `usage_limit`: the agent session to resume later (Issue #105). */
  sessionRef?: string | null;
  /** With `failed` / `delivery_failed`: what the delivery pushed before it failed (#141, S2). */
  pushedCommit?: string | null;
  /**
   * With `running` of a bring-up-to-date Follow-up (Issue #147): where the merge started, kept on
   * its conversation entry for the later claims of the part.
   */
  bringUpToDateStarted?: { baseCommit: string; integrationCommit: string } | null;
  /**
   * With `succeeded` and a bring-up-to-date Follow-up (Issue #147): the request changed nothing;
   * the Run returns to the result it had before it. `unchangedDetail` says why (default: the
   * branch was already up to date).
   */
  unchanged?: boolean;
  unchangedDetail?: string | null;
}
