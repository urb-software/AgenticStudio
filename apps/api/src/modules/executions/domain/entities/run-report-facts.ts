import type { RunDeliveryOutcome } from '../value-objects/run-delivery.js';
import type { RunFailure } from '../value-objects/run-failure.js';
import type { RunState } from '../value-objects/run-state.js';
import type { RunWorkingCopy } from '../value-objects/run-working-copy.js';

/** What an agent worker reports about a change of a Run's state. */
export interface RunStateReport {
  /** One of the states a worker reports (the shared contract restricts it). */
  state: RunState;
  /** Exactly when `state` is `failed`. */
  failure: RunFailure | null;
  /** A failed Run's Working copy state, when the worker could read it. */
  workingCopy?: RunWorkingCopy | null;
  /** With `succeeded`: how the Run was delivered. */
  delivery?: RunDeliveryOutcome | null;
  /** With `failed` / `usage_limit`: the agent session to resume later. */
  sessionRef?: string | null;
  /** With `failed` / `delivery_failed`: what the delivery pushed before it failed. */
  pushedCommit?: string | null;
  /** With `running` of a bring-up-to-date Follow-up: where the merge started. */
  bringUpToDateStarted?: { baseCommit: string; integrationCommit: string } | null;
  /**
   * With `succeeded` and a bring-up-to-date Follow-up: the request changed nothing;
   * `unchangedDetail` says why.
   */
  unchanged?: boolean;
  unchangedDetail?: string | null;
}
