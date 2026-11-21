import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import { runView, type RunView } from '../../run-view.js';
import {
  PREPARED_FOLLOW_UP_REPOSITORY,
  type PreparedFollowUpRepository,
} from '../../../domain/repositories/prepared-follow-up-repository.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import type { FollowUpView } from '../../../domain/value-objects/follow-up-view.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { RETENTION_POLICY, type RetentionPolicy } from '../../ports/retention-policy.js';
import { WORKER_LEASE, type WorkerLease } from '../../ports/worker-lease.js';
import { MERGE_SETTINGS, type MergeSettings } from '../../ports/merge-settings.js';
import {
  MERGE_APPROVAL_REPOSITORY,
  type MergeApprovalRepository,
} from '../../../domain/repositories/merge-approval-repository.js';
import { mergeApprovalView, type MergeApprovalView } from '../../merge-approval-view.js';
import { WORKER_STATUS_STORE, type WorkerStatusStore } from '../../ports/worker-status-store.js';
import { Lease } from '../../../domain/value-objects/lease.js';
import { WorkerPresence } from '../../../domain/value-objects/worker-presence.js';
import type { MergeUnavailableReason } from '../../../domain/value-objects/merge-unavailable-reason.js';
import { MergeAvailabilityRule } from '../../../domain/value-objects/merge-availability-rule.js';
import { RunNotFoundError } from '../../../domain/errors/run-errors.js';

export interface GetRunInput {
  runId: string;
}

export interface GetRunResult {
  run: RunView;
  followUp: FollowUpView;
  /** Without a host call: from the setting and the Run's remote. */
  merge: { available: true } | { available: false; reason: MergeUnavailableReason };
  /** The branch the Run's pull request merges into. */
  integrationBranch: string;
  /** `null` when the operator never approved a merge of this Run. */
  latestMergeApproval: MergeApprovalView | null;
}

/** Throws {@link RunNotFoundError}, also for a non-UUID id. */
@Injectable()
export class GetRunHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WORKER_STATUS_STORE) private readonly workers: WorkerStatusStore,
    @Inject(PREPARED_FOLLOW_UP_REPOSITORY)
    private readonly preparedFollowUps: PreparedFollowUpRepository,
    @Inject(WORKER_LEASE) private readonly lease: WorkerLease,
    @Inject(RETENTION_POLICY) private readonly retention: RetentionPolicy,
    @Inject(MERGE_SETTINGS) private readonly mergeSettings: MergeSettings,
    @Inject(MERGE_APPROVAL_REPOSITORY) private readonly mergeApprovals: MergeApprovalRepository,
  ) {}

  async execute(input: GetRunInput): Promise<GetRunResult> {
    const { runId } = input;
    const run = isRunId(runId) ? await this.runs.findById(runId) : null;
    if (!run) throw new RunNotFoundError();
    const now = this.clock.now();
    const over =
      this.retention.isLimited(run.retentionFacts()) &&
      this.retention.overLimit(await this.runs.findLimitedRuns([run.projectId])).has(run.id);
    const workers = {
      holderLastSeen:
        run.claim.lastClaimedBy === null
          ? undefined
          : this.workers.lastSeen(run.claim.lastClaimedBy),
      latest: this.workers.latest(),
    };
    const workerConnected = WorkerPresence.of(
      workers.latest,
      Lease.ofSeconds(this.lease.seconds),
    ).isAnyConnected(now);
    const preparedFollowUp = (await this.preparedFollowUps.findRunIdsAmong([run.id])).has(run.id);
    const approval = await this.mergeApprovals.findLatest(run.id);
    return {
      run: runView(run, { workerConnected, preparedFollowUp }),
      followUp: this.retention.followUpView(
        run.followUpAvailability(workers, now, this.lease.seconds),
        run.retentionFacts(),
        over,
        now,
      ),
      merge: this.mergeAvailability(run.remoteUrl),
      integrationBranch: run.delivery.integrationBranch,
      latestMergeApproval: approval === null ? null : mergeApprovalView(approval.asOf(now)),
    };
  }

  private mergeAvailability(remoteUrl: string): GetRunResult['merge'] {
    const reason = MergeAvailabilityRule.of(this.mergeSettings).unavailableReason(remoteUrl);
    return reason === null ? { available: true } : { available: false, reason };
  }
}
