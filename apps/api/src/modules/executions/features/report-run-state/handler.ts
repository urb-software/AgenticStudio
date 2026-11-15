import { Inject, Injectable } from '@nestjs/common';
import {
  assertTransition,
  IllegalRunTransitionError,
  isRunId,
  OPERATOR_CANCELLATION,
  type Run,
  type RunFailure,
  type RunState,
  type RunWorkingCopy,
} from '../../domain/entities/run.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  RunNotHeldError,
  type RunRepository,
} from '../../domain/repositories/run-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { RUN_LOG_SIGNAL, type RunLogSignal } from '../../ports/run-log-signal.js';

export interface ReportRunStateInput {
  runId: string;
  workerId: string;
  /** One of the states a worker reports (the shared contract restricts it). */
  state: RunState;
  /** Exactly when `state` is `failed`. */
  failure: RunFailure | null;
  /** A failed Run's Working copy state, when the worker could read it (Issue #98). */
  workingCopy?: RunWorkingCopy | null;
}

/**
 * Command (Issue #96): the agent worker holding a Run reports a change of state. With a
 * cancel request on the Run (Issue #100) the worker confirms the stop with `cancelled`; a
 * Run step that ended before the worker learned of the request, with `waiting_for_operator`
 * or `succeeded`, also ends the Run as `cancelled`, so the operator's cancel always holds. A
 * `cancelled` report without a request is refused. A repeat of the change that already applied
 * (the worker retried a report whose answer it never got) is a no-op success (review of #121).
 * Throws {@link RunNotFoundError},
 * {@link RunNotHeldError} (another worker holds it, or nobody does) or
 * `IllegalRunTransitionError`. Wakes the Run's live log streams.
 */
@Injectable()
export class ReportRunStateHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RUN_LOG_SIGNAL) private readonly signal: RunLogSignal,
  ) {}

  async execute(input: ReportRunStateInput): Promise<Run> {
    if (!isRunId(input.runId)) throw new RunNotFoundError();
    // A second pass only when a cancel request arrived between the read and the write.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const run = await this.runs.findById(input.runId);
      if (!run) throw new RunNotFoundError();
      const cancelRequested = run.cancelRequestedAt !== null;
      const to = targetState(input.state, cancelRequested);
      // Already applied by an earlier delivery from this worker: nothing to change.
      if (run.state === to && (run.claimedBy ?? run.releasedBy) === input.workerId) return run;
      if (run.claimedBy !== input.workerId) throw new RunNotHeldError();
      if (to === 'cancelled' && !cancelRequested) {
        throw new IllegalRunTransitionError(run.state, to);
      }
      assertTransition(run.state, to);
      const keepsWorkingCopy = to === 'failed' || to === 'cancelled' || to === 'timed_out';
      const changed = await this.runs.transitionClaimed({
        runId: run.id,
        workerId: input.workerId,
        from: run.state,
        to,
        failure: to === 'failed' ? input.failure : null,
        workingCopy: keepsWorkingCopy ? (input.workingCopy ?? null) : null,
        cancellation: to === 'cancelled' ? OPERATOR_CANCELLATION : null,
        cancelRequested,
        now: this.clock.now(),
      });
      if (changed) {
        // Live log streams re-read the state: a final Run ends them (Issue #99).
        this.signal.notify(run.id);
        return changed;
      }
    }
    // The Run changed between the read and the write (e.g. the sweep failed it).
    throw new RunNotHeldError();
  }
}

/** The state a report leads to: a cancel request turns a Run step's normal end into `cancelled`. */
function targetState(reported: RunState, cancelRequested: boolean): RunState {
  if (cancelRequested && (reported === 'waiting_for_operator' || reported === 'succeeded')) {
    return 'cancelled';
  }
  return reported;
}
