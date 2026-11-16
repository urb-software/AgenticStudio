import { FAILURE_DETAIL_MAX_LENGTH } from '@agentic-studio/contracts';
import { Inject, Injectable } from '@nestjs/common';
import {
  assertTransition,
  IllegalRunTransitionError,
  isFinal,
  isRunId,
  OPERATOR_CANCELLATION,
  OPERATOR_CANCELLATION_BRANCH_PUSHED,
  type PullRequestState,
  type Run,
  type RunDeliveryOutcome,
  type RunFailure,
  type RunState,
  type RunWorkingCopy,
} from '../../domain/entities/run.js';
import { keepsSnapshotForRetry } from '../../domain/entities/run-environment-file.js';
import { redactFailure, redactWorkingCopy } from '../../domain/services/log-redaction.js';
import {
  RUN_LOOKUP_REPOSITORY,
  type RunLookupRepository,
} from '../../domain/repositories/run-lookup-repository.js';
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
  /** With `failed` / `usage_limit`: the agent session to resume later (Issue #105). */
  sessionRef?: string | null;
  /** With `failed` / `delivery_failed`: what the delivery pushed before it failed (#141, S2). */
  pushedCommit?: string | null;
  /**
   * With `failed` / `preparation_failed`: the pull request state the worker read before it refused
   * a Follow-up (review S4 of #152).
   */
  pullRequestState?: PullRequestState | null;
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

/** What the conversation says when a bring-up-to-date request found nothing to merge (Issue #147). */
export function alreadyUpToDateDetail(integrationBranch: string): string {
  return (
    `The Run branch already has everything ${integrationBranch} has, so nothing was changed: ` +
    'no agent was started and nothing was pushed.'
  );
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
    @Inject(RUN_LOOKUP_REPOSITORY) private readonly lookups: RunLookupRepository,
  ) {}

  async execute(input: ReportRunStateInput): Promise<Run> {
    if (!isRunId(input.runId)) throw new RunNotFoundError();
    input = await this.redacted(input);
    // A second pass only when a cancel request arrived between the read and the write.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const run = await this.runs.findById(input.runId);
      if (!run) throw new RunNotFoundError();
      if (input.unchanged) return this.finishUpToDate(run, input);
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
      // Issue #147: where a bring-up-to-date merge started (only while this worker holds the Run;
      // a repeated report records nothing twice).
      if (input.bringUpToDateStarted && to === 'running') {
        await this.runs.recordUpdateStart(run.id, input.workerId, input.bringUpToDateStarted);
      }
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
        sessionRef: input.failure?.code === 'usage_limit' ? (input.sessionRef ?? null) : null,
        pushedCommit:
          input.failure?.code === 'delivery_failed' ? (input.pushedCommit ?? null) : null,
        cancelRequested,
        now: this.clock.now(),
      });
      if (changed) {
        // Issue #147: a succeeded bring-up-to-date part has its merge in the pushed Run branch.
        if (to === 'succeeded') await this.runs.recordMergedCommit(run.id);
        // Review S4 of #152: what the worker read about the pull request before it refused a
        // Follow-up is what the page shows.
        if (input.failure?.code === 'preparation_failed' && input.pullRequestState) {
          await this.lookups.recordObservedState(run.id, input.pullRequestState, this.clock.now());
        }
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
    if (!input.failure && !input.workingCopy && !input.unchangedDetail) return input;
    const known = await this.secrets.forRun(input.runId);
    return {
      ...input,
      unchangedDetail: input.unchangedDetail
        ? cutDetail(redactFailure({ code: 'unknown', detail: input.unchangedDetail }, known)).detail
        : input.unchangedDetail,
      failure: input.failure && cutDetail(redactFailure(input.failure, known)),
      workingCopy: input.workingCopy
        ? redactWorkingCopy(input.workingCopy, known)
        : input.workingCopy,
    };
  }

  /**
   * A bring-up-to-date request whose branch was already up to date (Issue #147): the Run goes back
   * to the result it had before, and its conversation notes that nothing was changed. A repeat
   * of the report that already applied is a no-op success.
   */
  private async finishUpToDate(run: Run, input: ReportRunStateInput): Promise<Run> {
    if (run.claimedBy !== input.workerId) {
      if (run.releasedBy === input.workerId && isFinal(run.state)) return run;
      throw new RunNotHeldError();
    }
    const changed = await this.runs.finishBringUpToDate(
      run.id,
      input.workerId,
      input.unchangedDetail ?? alreadyUpToDateDetail(run.integrationBranch),
      this.clock.now(),
    );
    if (!changed) throw new IllegalRunTransitionError(run.state, 'succeeded');
    this.signal.notify(run.id);
    return changed;
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
      pushedCommit: result.state === 'failed' ? (input.pushedCommit ?? null) : null,
      now: this.clock.now(),
    });
    if (!changed) throw new RunNotHeldError();
    if (result.state === 'succeeded') await this.runs.recordMergedCommit(run.id);
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
