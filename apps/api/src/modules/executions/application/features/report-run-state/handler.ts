import { FAILURE_DETAIL_MAX_LENGTH } from '@agentic-studio/contracts';
import { Inject, Injectable } from '@nestjs/common';
import type { RunSnapshot } from '../../../domain/entities/run-snapshot.js';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import { type PullRequestState } from '../../../domain/value-objects/run-pull-request-status.js';
import { type RunDeliveryOutcome } from '../../../domain/value-objects/run-delivery.js';
import { type RunFailure } from '../../../domain/value-objects/run-failure.js';
import { type RunState } from '../../../domain/value-objects/run-state.js';
import { type RunWorkingCopy } from '../../../domain/value-objects/run-working-copy.js';
import { LogRedaction } from '../../../domain/value-objects/log-redaction.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import {
  ENVIRONMENT_FILE_SNAPSHOTS,
  type EnvironmentFileSnapshots,
} from '../../ports/environment-file-snapshots.js';
import { RUN_LOG_SIGNAL, type RunLogSignal } from '../../ports/run-log-signal.js';
import { RUN_SECRET_VALUES, type RunSecretValues } from '../../ports/run-secret-values.js';
import { RunNotFoundError } from '../../../domain/errors/run-errors.js';

export interface ReportRunStateInput {
  runId: string;
  workerId: string;
  state: RunState;
  failure: RunFailure | null;
  workingCopy?: RunWorkingCopy | null;
  delivery?: RunDeliveryOutcome | null;
  sessionRef?: string | null;
  pushedCommit?: string | null;
  pullRequestState?: PullRequestState | null;
  bringUpToDateStarted?: { baseCommit: string; integrationCommit: string } | null;
  unchanged?: boolean;
  unchangedDetail?: string | null;
}

export interface ReportRunStateResult {
  run: RunSnapshot;
}

/**
 * Decided by the Run's `reportState` under its row lock; wakes the Run's live log streams.
 * Failure detail and commit subjects are redacted with the Run's known values before storing.
 * Throws {@link RunNotFoundError}, `RunNotHeldError` or `IllegalRunTransitionError`.
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
    // Under the Run's row lock, a cancel, an Answer or a sweep that came first is seen as the state
    // it left.
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
    if (!applied) return { run: changed.snapshot() };
    if (input.failure?.code === 'preparation_failed' && input.pullRequestState) {
      const observed = input.pullRequestState;
      const at = this.clock.now();
      await this.runs.change(changed.id, (run) => run.recordObservedPullRequestState(observed, at));
    }
    this.signal.notify(changed.id);
    // A failed delivery that can be retried, or a Run that can resume after the usage limit, keeps
    // its snapshot. A bring-up request that changed nothing leaves the Run as
    // it was, snapshot included.
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
