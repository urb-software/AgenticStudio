import { FAILURE_DETAIL_MAX_LENGTH } from '@agentic-studio/contracts';
import { Inject, Injectable } from '@nestjs/common';
import {
  assertTransition,
  IllegalRunTransitionError,
  isFinal,
  isRunId,
  OPERATOR_CANCELLATION,
  OPERATOR_CANCELLATION_BRANCH_PUSHED,
  type Run,
  type RunDeliveryOutcome,
  type RunFailure,
  type RunState,
  type RunWorkingCopy,
} from '../../domain/entities/run.js';
import { keepsSnapshotForRetry } from '../../domain/entities/run-environment-file.js';
import { redactFailure, redactWorkingCopy } from '../../domain/services/log-redaction.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  RunNotHeldError,
  type RunRepository,
} from '../../domain/repositories/run-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import {
  ENVIRONMENT_FILE_SNAPSHOTS,
  type EnvironmentFileSnapshots,
} from '../../ports/environment-file-snapshots.js';
import { RUN_LOG_SIGNAL, type RunLogSignal } from '../../ports/run-log-signal.js';
import { RUN_SECRET_VALUES, type RunSecretValues } from '../../ports/run-secret-values.js';

export interface ReportRunStateInput {
  runId: string;
  workerId: string;
  /** One of the states a worker reports (the shared contract restricts it). */
  state: RunState;
  /** Exactly when `state` is `failed`. */
  failure: RunFailure | null;
  /** A failed Run's Working copy state, when the worker could read it (Issue #98). */
  workingCopy?: RunWorkingCopy | null;
  /** With `succeeded`: how the Run was delivered (Issue #102). */
  delivery?: RunDeliveryOutcome | null;
}

/**
 * Command (Issue #96): the agent worker holding a Run reports a change of state, with how a
 * succeeded Run was delivered (Issue #102). For a `failed` Run it holds for a delivery retry
 * it reports the retry's outcome: `succeeded` with the delivery, or `failed` with
 * `delivery_failed` again. With a cancel request on the Run (Issue #100) the worker confirms
 * the stop with `cancelled`; a Run step that ended with `waiting_for_operator` before the
 * worker learned of the request also ends the Run as `cancelled`, so the operator's cancel
 * holds (a `succeeded` report keeps its delivery: the worker delivers only while no stop is
 * pending). A `cancelled` report without a request is refused. A repeat of the change that
 * already applied (the worker retried a report whose answer it never got) is a no-op success
 * (review of #121). Throws {@link RunNotFoundError}, {@link RunNotHeldError} (another worker
 * holds it, or nobody does) or `IllegalRunTransitionError`. Wakes the Run's live log streams.
 * Issue #104: the failure detail and the commit subjects are redacted with the Run's known
 * values before they are stored (a retry's too: a retryable failed delivery keeps its
 * snapshot), and the snapshot is deleted once the Run needs no more redaction.
 */
@Injectable()
export class ReportRunStateHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RUN_LOG_SIGNAL) private readonly signal: RunLogSignal,
    @Inject(ENVIRONMENT_FILE_SNAPSHOTS) private readonly snapshots: EnvironmentFileSnapshots,
    @Inject(RUN_SECRET_VALUES) private readonly secrets: RunSecretValues,
  ) {}

  async execute(input: ReportRunStateInput): Promise<Run> {
    if (!isRunId(input.runId)) throw new RunNotFoundError();
    input = await this.redacted(input);
    // A second pass only when a cancel request arrived between the read and the write.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const run = await this.runs.findById(input.runId);
      if (!run) throw new RunNotFoundError();
      if (run.state === 'failed' && run.deliveryRequested && run.claimedBy === input.workerId) {
        return this.finishRetry(run, input);
      }
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
        // A cancel that arrived during the delivery keeps what was delivered (review of #121).
        delivery: to === 'succeeded' || to === 'cancelled' ? (input.delivery ?? null) : null,
        cancellation:
          to !== 'cancelled'
            ? null
            : input.delivery?.outcome === 'none' && input.delivery.branchPushed
              ? OPERATOR_CANCELLATION_BRANCH_PUSHED
              : OPERATOR_CANCELLATION,
        cancelRequested,
        now: this.clock.now(),
      });
      if (changed) {
        // Live log streams re-read the state: a final Run ends them (Issue #99).
        this.signal.notify(run.id);
        // A final Run needs no more redaction, unless its failed delivery can be retried:
        // its Environment file snapshot goes now, or when the retry ends it (Issue #104).
        if (
          changed.environmentFileSupplied &&
          isFinal(changed.state) &&
          !keepsSnapshotForRetry(changed)
        ) {
          await this.snapshots.releaseFor(run.id);
        }
        return changed;
      }
    }
    // The Run changed between the read and the write (e.g. the sweep failed it).
    throw new RunNotHeldError();
  }

  /** The worker's free text (failure detail, commit subjects) redacted like the log (#104). */
  private async redacted(input: ReportRunStateInput): Promise<ReportRunStateInput> {
    if (!input.failure && !input.workingCopy) return input;
    const known = await this.secrets.forRun(input.runId);
    return {
      ...input,
      failure: input.failure && cutDetail(redactFailure(input.failure, known)),
      workingCopy: input.workingCopy
        ? redactWorkingCopy(input.workingCopy, known)
        : input.workingCopy,
    };
  }

  /** The outcome of a delivery retry: the one way out of `failed` (Issue #102). */
  private async finishRetry(run: Run, input: ReportRunStateInput): Promise<Run> {
    const result =
      input.state === 'succeeded' && input.delivery
        ? { state: 'succeeded' as const, delivery: input.delivery }
        : input.state === 'failed' && input.failure?.code === 'delivery_failed'
          ? { state: 'failed' as const, failure: input.failure }
          : null;
    if (!result) throw new IllegalRunTransitionError(run.state, input.state);
    const changed = await this.runs.finishDeliveryRetry({
      runId: run.id,
      workerId: input.workerId,
      result,
      workingCopy: input.workingCopy ?? null,
      now: this.clock.now(),
    });
    if (!changed) throw new RunNotHeldError();
    this.signal.notify(run.id);
    // Delivered at last: nothing more to redact (Issue #104). A retry that failed again keeps
    // the snapshot, since the delivery can be retried once more.
    if (changed.environmentFileSupplied && !keepsSnapshotForRetry(changed)) {
      await this.snapshots.releaseFor(run.id);
    }
    return changed;
  }
}

/** Redaction can lengthen the detail; it is stored within the contract's limit. */
function cutDetail(failure: RunFailure): RunFailure {
  return { ...failure, detail: failure.detail.slice(0, FAILURE_DETAIL_MAX_LENGTH) };
}

/**
 * The state a report leads to: a cancel request turns a Run step that ended waiting for the
 * operator into `cancelled`. A `succeeded` report stays: it carries its delivery (Issue #102).
 */
function targetState(reported: RunState, cancelRequested: boolean): RunState {
  if (cancelRequested && reported === 'waiting_for_operator') {
    return 'cancelled';
  }
  return reported;
}
