import { FAILURE_DETAIL_MAX_LENGTH } from '@agentic-studio/contracts';
import { Inject, Injectable } from '@nestjs/common';
import type { RunSnapshot } from '../../../domain/value-objects/run-snapshot.js';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import { type PullRequestState } from '../../../domain/value-objects/run-pull-request-status.js';
import { type RunDeliveryOutcome } from '../../../domain/value-objects/run-delivery.js';
import { type RunFailure } from '../../../domain/value-objects/run-failure.js';
import { type RunState } from '../../../domain/value-objects/run-state.js';
import { type RunWorkingCopy } from '../../../domain/value-objects/run-working-copy.js';
import { LogRedaction } from '../../../domain/value-objects/log-redaction.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  type RunRepository,
} from '../../../domain/repositories/run-repository.js';
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

export interface ReportRunStateResult {
  /** The Run as it is now. */
  run: RunSnapshot;
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
 * (review of #121). The rules are the Run's `reportState`, run under the row lock (Issue #169).
 * Throws {@link RunNotFoundError}, `RunNotHeldError` (another worker holds it, or nobody does)
 * or `IllegalRunTransitionError`. Wakes the Run's live log streams.
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

  async execute(input: ReportRunStateInput): Promise<ReportRunStateResult> {
    if (!isRunId(input.runId)) throw new RunNotFoundError();
    input = await this.redacted(input);
    let applied = false;
    // The Run decides under its row lock (Issue #169): a cancel, an Answer or a sweep that came
    // first is seen as the state it left, and a report that no longer fits is refused.
    const changed = await this.runs.change(input.runId, (run) => {
      applied = run.reportState(
        input.workerId,
        {
          state: input.state,
          failure: input.failure,
          workingCopy: input.workingCopy ?? null,
          delivery: input.delivery ?? null,
          sessionRef: input.sessionRef ?? null,
          pushedCommit: input.pushedCommit ?? null,
          bringUpToDateStarted: input.bringUpToDateStarted ?? null,
          unchanged: input.unchanged === true,
          unchangedDetail: input.unchangedDetail ?? null,
        },
        this.clock.now(),
      );
    });
    if (!changed) throw new RunNotFoundError();
    // A repeat of the change that already applied (the worker retried a report whose answer it
    // never got): nothing to wake or release.
    if (!applied) return { run: changed.snapshot() };
    // Review S4 of #152: what the worker read about the pull request before it refused a
    // Follow-up is what the page shows.
    if (input.failure?.code === 'preparation_failed' && input.pullRequestState) {
      const observed = input.pullRequestState;
      const at = this.clock.now();
      await this.runs.change(changed.id, (run) => run.recordObservedPullRequestState(observed, at));
    }
    // Live log streams re-read the state: a final Run ends them (Issue #99).
    this.signal.notify(changed.id);
    // A final Run needs no more redaction, unless its failed delivery can be retried: its
    // Environment file snapshot goes now, or when the retry ends it (Issue #104). A bring-up
    // request that changed nothing leaves the Run as it was, snapshot included.
    if (
      !input.unchanged &&
      changed.claim.environmentFileSupplied &&
      changed.lifecycle.isFinal &&
      !changed.lifecycle.keepsEnvironmentFileForRetry
    ) {
      await this.snapshots.releaseFor(changed.id);
    }
    return { run: changed.snapshot() };
  }

  /** The worker's free text (failure detail, commit subjects) redacted like the log (#104). */
  private async redacted(input: ReportRunStateInput): Promise<ReportRunStateInput> {
    if (!input.failure && !input.workingCopy && !input.unchangedDetail) return input;
    const redaction = LogRedaction.of(await this.secrets.forRun(input.runId));
    return {
      ...input,
      unchangedDetail: input.unchangedDetail
        ? cutDetail(redaction.failure({ code: 'unknown', detail: input.unchangedDetail })).detail
        : input.unchangedDetail,
      failure: input.failure && cutDetail(redaction.failure(input.failure)),
      workingCopy: input.workingCopy ? redaction.workingCopy(input.workingCopy) : input.workingCopy,
    };
  }
}

/** Redaction can lengthen the detail; it is stored within the contract's limit. */
function cutDetail(failure: RunFailure): RunFailure {
  return { ...failure, detail: failure.detail.slice(0, FAILURE_DETAIL_MAX_LENGTH) };
}
