import { Inject, Injectable } from '@nestjs/common';
import {
  ClosePullRequestRefusedError,
  RunNotFoundError,
} from '../../../domain/errors/run-errors.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { MergeAvailabilityRule } from '../../../domain/value-objects/merge-availability-rule.js';
import type { PullRequestState } from '../../../domain/value-objects/pull-request-state.js';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import {
  MERGE_HOST,
  type MergeHost,
  type MergeHostFailure,
  type PullRequestScope,
} from '../../ports/merge-host.js';
import { MERGE_SETTINGS, type MergeSettings } from '../../ports/merge-settings.js';

export interface ClosePullRequestInput {
  runId: string;
}

export interface ClosePullRequestResult {
  state: PullRequestState;
  closedFromStudioAt: Date;
  /** `null` while the Run branch is still on the Git host. */
  runBranchDeletedAt: Date | null;
  runBranchDeletionFailure: string | null;
}

/**
 * A failed branch deletion keeps the close; a repeat retries only what is left, and a finished
 * one calls no host. Throws `ClosePullRequestRefusedError` (nothing recorded) or `CloseInProgressError`.
 */
@Injectable()
export class ClosePullRequestHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(MERGE_HOST) private readonly host: MergeHost,
    @Inject(MERGE_SETTINGS) private readonly settings: MergeSettings,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: ClosePullRequestInput): Promise<ClosePullRequestResult> {
    const { runId } = input;
    const found = isRunId(runId) ? await this.runs.findById(runId) : null;
    if (!found) throw new RunNotFoundError();
    if (MergeAvailabilityRule.of(this.settings).unavailableReason(found.remoteUrl) !== null) {
      throw new ClosePullRequestRefusedError('merge_unavailable');
    }
    let stage = 'done' as 'close' | 'delete_branch' | 'done';
    const claimed = await this.runs.change(runId, (run) => {
      stage = run.claimClose(this.clock.now());
    });
    if (!claimed) throw new RunNotFoundError();
    const host = claimed.hostPullRequest;
    if (stage !== 'done' && host !== null) {
      const scope: PullRequestScope = {
        remoteUrl: claimed.remoteUrl,
        runId,
        integrationBranch: claimed.delivery.integrationBranch,
        ...host,
      };
      if (stage === 'close') await this.close(runId, scope);
      await this.deleteRunBranch(runId, scope);
    }
    return this.result(runId);
  }

  private async close(runId: string, scope: PullRequestScope): Promise<void> {
    const read = await this.host.readPullRequest(scope);
    if (!read.ok) {
      if (read.failure.code === 'not_found') throw await this.ended(runId, 'missing');
      throw await this.refused(runId, read.failure);
    }
    if (read.pullRequest.state !== 'open') throw await this.ended(runId, read.pullRequest.state);
    const closed = await this.host.close(scope);
    if (!closed.ok) throw await this.refused(runId, closed.failure);
    await this.runs.change(runId, (run) => run.recordClosedFromStudio(this.clock.now()));
  }

  private async deleteRunBranch(runId: string, scope: PullRequestScope): Promise<void> {
    const deleted = await this.host.deleteRunBranch(scope);
    const failure = deleted.ok || deleted.failure.code === 'not_found' ? null : deleted.failure;
    await this.runs.change(runId, (run) => {
      if (failure === null) run.recordBranchDeleted(this.clock.now());
      else run.recordBranchDeletionFailed(failureText(failure));
    });
  }

  /** Stores what the host reported; the refusal is that the pull request is not open. */
  private async ended(
    runId: string,
    state: 'merged' | 'closed' | 'missing',
  ): Promise<ClosePullRequestRefusedError> {
    await this.runs.change(runId, (run) => {
      run.recordObservedPullRequestState(state, this.clock.now());
      run.releaseCloseClaim();
    });
    return new ClosePullRequestRefusedError('pull_request_not_open');
  }

  private async refused(
    runId: string,
    failure: MergeHostFailure,
  ): Promise<ClosePullRequestRefusedError> {
    await this.runs.change(runId, (run) => run.releaseCloseClaim());
    if (failure.code === 'not_configured' || failure.code === 'unsupported_host') {
      return new ClosePullRequestRefusedError('merge_unavailable');
    }
    return new ClosePullRequestRefusedError('host_refused', failureText(failure));
  }

  private async result(runId: string): Promise<ClosePullRequestResult> {
    const run = (await this.runs.findById(runId))!;
    const { state, closedFromStudioAt, runBranchDeletedAt, runBranchDeletionFailure } =
      run.pullRequestStatus;
    return {
      state: state!,
      closedFromStudioAt: closedFromStudioAt!,
      runBranchDeletedAt,
      runBranchDeletionFailure,
    };
  }
}

function failureText(failure: MergeHostFailure): string {
  switch (failure.code) {
    case 'refused':
      return failure.message;
    case 'rate_limited':
      return `GitHub is limiting requests: try again in ${failure.retryAfterSeconds} seconds.`;
    case 'unavailable':
      return 'GitHub could not be reached.';
    case 'scope_mismatch':
      return 'The pull request does not belong to this run.';
    case 'not_found':
      return 'GitHub did not find it.';
    case 'not_configured':
    case 'unsupported_host':
      return 'Studio cannot reach the Git host for this run.';
  }
}
