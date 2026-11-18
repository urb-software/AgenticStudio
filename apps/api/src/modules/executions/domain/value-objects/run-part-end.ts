import type { FinalRunState } from './run-state.js';
import type { RunFailureCode } from './run-failure-code.js';
import type { RunDeliveryState } from './run-delivery.js';

/**
 * Recorded when a Follow-up reopens the Run, before its result is cleared, so the earlier result
 * stays in the conversation. `detail` is the failure detail or the
 * cancellation reason; empty otherwise.
 */
export interface RunPartEnd {
  state: FinalRunState;
  failureCode: RunFailureCode | null;
  delivery: RunDeliveryState | null;
  detail: string;
}
