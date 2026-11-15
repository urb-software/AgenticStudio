import { FAILURE_DETAIL_MAX_LENGTH } from '@agentic-studio/contracts';
import { Inject, Injectable } from '@nestjs/common';
import {
  assertTransition,
  IllegalRunTransitionError,
  isFinal,
  isRunId,
  type Run,
  type RunDeliveryOutcome,
  type RunFailure,
  type RunState,
  type RunWorkingCopy,
} from '../../domain/entities/run.js';
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
 * `delivery_failed` again. Throws {@link RunNotFoundError}, {@link RunNotHeldError} (another
 * worker holds it, or nobody does) or `IllegalRunTransitionError`. Wakes the Run's live log streams. Issue #104: the failure detail and
 * the commit subjects are redacted with the Run's known values before they are stored, and a
 * final Run's Environment file snapshot is deleted.
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
    const run = await this.runs.findById(input.runId);
    if (!run) throw new RunNotFoundError();
    if (run.claimedBy !== input.workerId) throw new RunNotHeldError();
    input = await this.redacted(input);
    if (run.state === 'failed' && run.deliveryRequested) return this.finishRetry(run, input);
    assertTransition(run.state, input.state);
    const changed = await this.runs.transitionClaimed({
      runId: run.id,
      workerId: input.workerId,
      from: run.state,
      to: input.state,
      failure: input.state === 'failed' ? input.failure : null,
      workingCopy: input.state === 'failed' ? (input.workingCopy ?? null) : null,
      delivery: input.state === 'succeeded' ? (input.delivery ?? null) : null,
      now: this.clock.now(),
    });
    // The Run changed between the read and the write (e.g. the sweep failed it).
    if (!changed) throw new RunNotHeldError();
    // Live log streams re-read the state: a final Run ends them (Issue #99).
    this.signal.notify(run.id);
    // A final Run stores no more events: its Environment file snapshot goes (Issue #104).
    if (isFinal(changed.state)) await this.snapshots.releaseFor(run.id);
    return changed;
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
    return changed;
  }
}

/** Redaction can lengthen the detail; it is stored within the contract's limit. */
function cutDetail(failure: RunFailure): RunFailure {
  return { ...failure, detail: failure.detail.slice(0, FAILURE_DETAIL_MAX_LENGTH) };
}
