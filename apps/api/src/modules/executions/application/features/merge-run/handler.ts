import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { MergeApproval } from '../../../domain/entities/merge-approval.js';
import type { Run } from '../../../domain/entities/run.js';
import { MergeRefusedError } from '../../../domain/errors/merge-approval-errors.js';
import { RunNotFoundError } from '../../../domain/errors/run-errors.js';
import {
  MERGE_APPROVAL_REPOSITORY,
  type MergeApprovalRepository,
} from '../../../domain/repositories/merge-approval-repository.js';
import {
  RUN_MERGE_REVIEW_REPOSITORY,
  type RunMergeReviewRepository,
} from '../../../domain/repositories/run-merge-review-repository.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { MergeAvailabilityRule } from '../../../domain/value-objects/merge-availability-rule.js';
import { CommitId } from '../../../domain/value-objects/commit-id.js';
import { MergeApprovalLease } from '../../../domain/value-objects/merge-approval-lease.js';
import { MergeHostRule } from '../../../domain/value-objects/merge-host-rule.js';
import { MergeStudioRule } from '../../../domain/value-objects/merge-studio-rule.js';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import {
  RUN_INTEGRATION_FETCHES,
  RUN_MERGE_METHODS,
  type RunIntegrationFetches,
  type RunMergeMethods,
} from '../../../../projects/contracts/index.js';
import { mergeApprovalView, type MergeApprovalView } from '../../merge-approval-view.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import {
  MERGE_HOST,
  type HostPullRequest,
  type MergeHost,
  type MergeHostFailure,
  type PullRequestScope,
} from '../../ports/merge-host.js';
import { MERGE_SETTINGS, type MergeSettings } from '../../ports/merge-settings.js';

export interface MergeRunInput {
  runId: string;
  /** The commit the operator reviewed. */
  commit: string;
}

export interface MergeRunResult {
  approval: MergeApprovalView;
  /** `null` while the Run branch is still on the Git host. */
  runBranchDeletedAt: Date | null;
  runBranchDeletionFailure: string | null;
}

/** Merges the pull request pinned to the approved commit, once Studio read it and its checks. */
@Injectable()
export class MergeRunHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(MERGE_APPROVAL_REPOSITORY) private readonly approvals: MergeApprovalRepository,
    @Inject(RUN_MERGE_REVIEW_REPOSITORY) private readonly reviews: RunMergeReviewRepository,
    @Inject(MERGE_HOST) private readonly host: MergeHost,
    @Inject(MERGE_SETTINGS) private readonly settings: MergeSettings,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RUN_INTEGRATION_FETCHES) private readonly integrationFetches: RunIntegrationFetches,
    @Inject(RUN_MERGE_METHODS) private readonly mergeMethods: RunMergeMethods,
  ) {}

  /** Throws `RunNotFoundError` or `MergeRefusedError`. */
  async execute(input: MergeRunInput): Promise<MergeRunResult> {
    return this.run(input, false);
  }

  private async run(input: MergeRunInput, reentered: boolean): Promise<MergeRunResult> {
    const { runId } = input;
    const commit = input.commit.toLowerCase();
    const run = isRunId(runId) ? await this.runs.findById(runId) : null;
    if (!run) throw new RunNotFoundError();
    const now = this.clock.now();
    let latest = await this.approvals.findLatest(runId);
    if (latest?.isPending && !latest.asOf(now).isPending) {
      // The request that stored it died: it ends as interrupted, whoever finishes it first.
      await this.approvals.finish(latest.asOf(now));
      latest = await this.approvals.findLatest(runId);
    }
    if (latest?.isCarriedOut) return this.finishAfterMerge(run, latest);
    if (latest?.isPending) throw new MergeRefusedError('merge_in_progress');
    this.requireAvailable(run);

    const scope = this.scopeOf(run);
    if (latest?.mergeOutcomeUnknown && scope !== null) {
      const reconciled = await this.reconcile(scope, latest);
      if (reconciled) return this.finishAfterMerge((await this.runs.findById(runId))!, reconciled);
    }
    const review = await this.reviews.find(runId);
    const refusal = MergeStudioRule.of({
      commit,
      runActive: run.isActive,
      hasPullRequest: scope !== null,
      review: {
        state: review?.stateAt(now, run.latestKnownHead()) ?? 'none',
        runCommit: review?.runCommit ?? null,
      },
    }).refusal();
    if (refusal !== null || scope === null) {
      throw new MergeRefusedError(refusal ?? 'pull_request_not_open');
    }

    const read = await this.host.readPullRequest(scope);
    if (!read.ok) throw await this.refusedBefore(runId, read.failure);
    const checks = await this.host.readChecks(scope, commit);
    if (!checks.ok) throw await this.refusedBefore(runId, checks.failure);
    const pullRequest = read.pullRequest;
    const hostRefusal = MergeHostRule.of({ commit, pullRequest, checks: checks.checks }).refusal();
    if (hostRefusal !== null) {
      if (pullRequest.state !== 'open') await this.observe(runId, pullRequest.state);
      throw new MergeRefusedError(hostRefusal);
    }

    // Read once, after every precondition passed: the approval records it and the merge uses it.
    const method = await this.mergeMethods.mergeMethodFor(run.projectId);
    const approval = MergeApproval.approve(
      {
        id: randomUUID(),
        runId,
        commit,
        integrationBranch: run.delivery.integrationBranch,
        method,
        checksSeen: checks.checks,
      },
      this.clock.now(),
    );
    if (!(await this.approvals.add(approval))) throw new MergeRefusedError('merge_in_progress');
    const merged = await this.carryOut(scope, approval, pullRequest);
    if (merged === null) {
      // Another request took the approval over while this one merged: it answers from the record.
      if (reentered) throw new MergeRefusedError('merge_in_progress');
      return this.run(input, true);
    }
    return this.finishAfterMerge((await this.runs.findById(runId))!, merged);
  }

  /** An approval whose merge call may have succeeded unseen becomes carried out if the host merged it. */
  private async reconcile(
    scope: PullRequestScope,
    approval: MergeApproval,
  ): Promise<MergeApproval | null> {
    const read = await this.host.readPullRequest(scope);
    if (!read.ok) return null;
    const { state, headSha, mergedCommit } = read.pullRequest;
    if (state !== 'merged' || mergedCommit === null) return null;
    if (!CommitId.of(approval.commit).equals(headSha)) return null;
    const done = approval.carriedOut(mergedCommit, this.clock.now());
    await this.approvals.save(done);
    await this.observe(approval.runId, 'merged');
    return done;
  }

  /**
   * The approving review comes from the operator's own token: the Merge credential is the
   * operator's and the pull request's author is the Agent account, so it is not a self-approval.
   */
  private async carryOut(
    scope: PullRequestScope,
    approval: MergeApproval,
    pullRequest: HostPullRequest,
  ): Promise<MergeApproval | null> {
    const { commit } = approval;
    if (pullRequest.draft) {
      await this.requireTimeFor(approval);
      const ready = await this.host.markReady(scope);
      if (!ready.ok) throw await this.refusedAfter(approval, ready.failure);
    }
    await this.requireTimeFor(approval);
    const approved = await this.host.approve(scope, commit);
    if (!approved.ok) throw await this.refusedAfter(approval, approved.failure);
    await this.requireTimeFor(approval);
    // From here the host may merge without Studio hearing of it: a record made from now on says so.
    const requested = approval.mergeRequested(this.clock.now());
    if (!(await this.approvals.requestMerge(requested))) return null;
    const merged = await this.host.merge(scope, {
      sha: commit,
      method: approval.method,
      // A squash commit carries the pull request's own words; a merge commit keeps the host's.
      ...(approval.method === 'squash'
        ? {
            title: pullRequest.title,
            ...(pullRequest.body === '' ? {} : { message: pullRequest.body }),
          }
        : {}),
    });
    if (!merged.ok) {
      throw await this.refusedAfter(
        requested,
        merged.failure,
        merged.failure.code === 'unavailable',
      );
    }
    const done = requested.carriedOut(merged.mergedCommit, this.clock.now());
    const stored = await this.approvals.finish(done);
    await this.observe(approval.runId, 'merged');
    return stored ? done : null;
  }

  /** No host step starts when too little of the lease is left for it to end inside it. */
  private async requireTimeFor(approval: MergeApproval): Promise<void> {
    const now = this.clock.now();
    if (MergeApprovalLease.at(now).allowsAStep(approval.approvedAt)) return;
    await this.approvals.finish(approval.notCarriedOut('interrupted', MergeApproval.TOO_SLOW, now));
    throw new MergeRefusedError('host_refused', MergeApproval.TOO_SLOW);
  }

  /** The steps after a merge that are still missing; each is best effort and never undoes it. */
  private async finishAfterMerge(run: Run, approval: MergeApproval): Promise<MergeRunResult> {
    const scope = this.scopeOf(run);
    const branchLeft = run.runBranchPending;
    const fetchLeft = approval.cloneFetchPending;
    let current = approval;
    if (scope !== null && (branchLeft || fetchLeft)) {
      this.requireAvailable(run);
      if (branchLeft) await this.deleteRunBranch(run.id, scope);
      if (fetchLeft) current = await this.fetchIntegrationBranch(run.projectId, approval);
    }
    const stored = (await this.runs.findById(run.id))!.pullRequestStatus;
    return {
      approval: mergeApprovalView(current),
      runBranchDeletedAt: stored.runBranchDeletedAt,
      runBranchDeletionFailure: stored.runBranchDeletionFailure,
    };
  }

  private async deleteRunBranch(runId: string, scope: PullRequestScope): Promise<void> {
    const deleted = await this.host.deleteRunBranch(scope);
    const failure = deleted.ok || deleted.failure.code === 'not_found' ? null : deleted.failure;
    await this.runs.change(runId, (run) => {
      if (failure === null) run.recordBranchDeleted(this.clock.now());
      else run.recordBranchDeletionFailed(failureText(failure));
    });
  }

  /**
   * Recorded only once the Repository took the fetch up: while it did not start, it may have been
   * a fetch that predates the merge, so the page offers a retry.
   */
  private async fetchIntegrationBranch(
    projectId: string,
    approval: MergeApproval,
  ): Promise<MergeApproval> {
    try {
      const fetched = await this.integrationFetches.fetchIntegrationBranch(projectId);
      if (fetched.status !== 'started') return approval;
    } catch {
      return approval;
    }
    const started = approval.cloneFetchStarted(this.clock.now());
    await this.approvals.save(started);
    return started;
  }

  private requireAvailable(run: Run): void {
    if (MergeAvailabilityRule.of(this.settings).unavailableReason(run.remoteUrl) !== null) {
      throw new MergeRefusedError('merge_unavailable');
    }
  }

  private scopeOf(run: Run): PullRequestScope | null {
    const host = run.hostPullRequest;
    if (host === null) return null;
    return {
      remoteUrl: run.remoteUrl,
      runId: run.id,
      integrationBranch: run.delivery.integrationBranch,
      ...host,
    };
  }

  /** Stores what the host reported, so the Run page shows it. */
  private async observe(runId: string, state: 'merged' | 'closed' | 'missing'): Promise<void> {
    await this.runs.change(runId, (run) =>
      run.recordObservedPullRequestState(state, this.clock.now()),
    );
  }

  /** A host failure before the approval was stored: only what the host showed is recorded. */
  private async refusedBefore(
    runId: string,
    failure: MergeHostFailure,
  ): Promise<MergeRefusedError> {
    if (failure.code === 'not_found') {
      await this.observe(runId, 'missing');
      return new MergeRefusedError('pull_request_not_open');
    }
    return refusalOf(failure).error;
  }

  /** A host failure after the approval was stored: the approval is kept as not carried out. */
  private async refusedAfter(
    approval: MergeApproval,
    failure: MergeHostFailure,
    outcomeUnknown = false,
  ): Promise<MergeRefusedError> {
    const { error, code } = refusalOf(failure);
    const reason = error.detail ?? failureText(failure);
    const recorded = outcomeUnknown
      ? approval.notCarriedOut(
          'interrupted',
          `${reason} The merge may have gone through.`,
          this.clock.now(),
        )
      : approval.notCarriedOut(code, reason, this.clock.now());
    await this.approvals.finish(recorded);
    return error;
  }
}

function refusalOf(failure: MergeHostFailure): {
  error: MergeRefusedError;
  code: NonNullable<MergeApproval['refusal']>['code'];
} {
  if (failure.code === 'not_configured' || failure.code === 'unsupported_host') {
    return { error: new MergeRefusedError('merge_unavailable'), code: 'merge_unavailable' };
  }
  return {
    error: new MergeRefusedError('host_refused', failureText(failure)),
    code: 'host_refused',
  };
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
