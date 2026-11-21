import { HandOutRule } from '../value-objects/hand-out-rule.js';
import type { FollowUpEligibility } from '../value-objects/follow-up-eligibility.js';
import type { FollowUpRefusal } from '../value-objects/follow-up-refusal.js';
import { PROVIDERS } from '../value-objects/provider.js';
import { RunConversation } from '../value-objects/run-conversation.js';
import { type BringUpDetails } from '../value-objects/bring-up-details.js';
import type { RunMessage } from '../value-objects/run-message.js';
import type { RunQuestion } from '../value-objects/run-question.js';
import type { RunData } from './run-data.js';
import { EarlierResult } from '../value-objects/earlier-result.js';
import { RunDelivery } from '../value-objects/run-delivery.js';
import {
  CloseInProgressError,
  ClosePullRequestRefusedError,
  DeliveryNotRetryableError,
  FollowUpNotAllowedError,
  IllegalRunTransitionError,
  ReviewCommentsNotLoadedError,
  RunAlreadyFinishedError,
  RunNotHeldError,
  RunNotResumableError,
  RunNotWaitingError,
  RunSlotTakenError,
  StepOutOfOrderError,
} from '../errors/run-errors.js';
import { RunFailure } from '../value-objects/run-failure.js';
import type { HandOutView } from '../value-objects/hand-out-view.js';
import type { RunHandOut } from '../value-objects/run-hand-out.js';
import type { FollowUpConsumption, FollowUpOrigin } from './run-follow-up-facts.js';
import type { FollowUpFacts, WorkerFacts } from './run-worker-facts.js';
import type { ResumeFacts } from './run-resume-facts.js';
import type { RetentionFacts } from '../value-objects/retention-facts.js';
import type { EnvironmentFileSnapshotFacts } from '../value-objects/environment-file-snapshot-facts.js';
import type { LimitedRunFacts } from '../value-objects/limited-run-facts.js';
import type { PullRequestRefreshFacts } from '../value-objects/pull-request-refresh-facts.js';
import type { RunSweepFacts } from '../value-objects/run-sweep-facts.js';
import type { RunChanges } from './run-change-facts.js';
import type { RunStartInput } from './run-start-facts.js';
import type { RunStateReport } from './run-report-facts.js';
import type { RunStepOutcome, RunStepRecord } from './run-step-facts.js';
import { RunLifecycle } from '../value-objects/run-lifecycle.js';
import { RunProgress } from '../value-objects/run-progress.js';
import { RunPullRequestStatus } from '../value-objects/run-pull-request-status.js';
import {
  isEndedPullRequestState,
  type PullRequestState,
} from '../value-objects/pull-request-state.js';
import { type PullRequestStateResult } from '../value-objects/pull-request-state-result.js';
import type { RunResume } from '../value-objects/run-resume.js';
import { isClaimedRunState, isFinalRunState, type RunState } from '../value-objects/run-state.js';
import { RunCancellation } from '../value-objects/run-cancellation.js';
import { RunWorkerClaim } from '../value-objects/run-worker-claim.js';
import type { RunWorkingCopy } from '../value-objects/run-working-copy.js';
import { Lease } from '../value-objects/lease.js';
import { WorkerPresence } from '../value-objects/worker-presence.js';
import type { LookupKind } from '../value-objects/lookup-kind.js';
import { RunStep } from './run-step.js';

type RunPatch = Partial<
  Omit<
    RunData,
    | 'messages'
    | 'id'
    | 'projectId'
    | 'provider'
    | 'task'
    | 'startCommit'
    | 'remoteUrl'
    | 'createdAt'
  >
>;

const NO_REMOTE = RunFailure.of(
  'preparation_failed',
  "The run has no repository remote to prepare from (the project's repository was removed).",
);

const NOT_DELIVERABLE = RunFailure.of(
  'delivery_failed',
  'The run cannot be delivered: it has no repository remote, integration branch or recorded ' +
    'Run branch.',
);

const NOT_RESUMABLE = RunFailure.of(
  'preparation_failed',
  'Working copy no longer exists — run again: Studio has no recorded Working copy, repository ' +
    'remote or integration branch for this run.',
);

const WORKING_COPY_REMOVED = RunFailure.of(
  'preparation_failed',
  "Working copy no longer exists — run again: the agent worker's retention removed it.",
);

const CHANGES = new WeakMap<Run, RunChanges>();

/**
 * The store saves {@link Run.pendingChanges} in one transaction under the
 * Run's row lock, so two simultaneous requests cannot both succeed.
 */
export class Run {
  declare readonly id: RunData['id'];
  declare readonly projectId: RunData['projectId'];
  declare readonly provider: RunData['provider'];
  declare readonly task: RunData['task'];
  declare readonly startCommit: RunData['startCommit'];
  /** Never a credential. */
  declare readonly remoteUrl: RunData['remoteUrl'];
  declare readonly createdAt: RunData['createdAt'];
  declare readonly lifecycle: RunLifecycle;
  declare readonly delivery: RunDelivery;
  declare readonly pullRequestStatus: RunPullRequestStatus;
  declare readonly conversation: RunConversation;
  declare readonly claim: RunWorkerClaim;
  declare readonly progress: RunProgress;
  declare readonly workingCopy: RunWorkingCopy | null;
  declare readonly failingChecks: readonly string[];

  private constructor(data: RunData) {
    Object.assign(this, {
      id: data.id,
      projectId: data.projectId,
      provider: data.provider,
      task: data.task,
      startCommit: data.startCommit,
      remoteUrl: data.remoteUrl,
      createdAt: data.createdAt,
      lifecycle: RunLifecycle.restore(data),
      delivery: RunDelivery.restore(data),
      pullRequestStatus: RunPullRequestStatus.restore(data.pullRequestStatus),
      conversation: RunConversation.restore(data),
      claim: RunWorkerClaim.restore(data),
      progress: RunProgress.restore(data),
      workingCopy:
        data.workingCopy === null
          ? null
          : { ...data.workingCopy, commits: data.workingCopy.commits.map((c) => ({ ...c })) },
      failingChecks: [...data.failingChecks],
    });
    CHANGES.set(this, { fields: {}, messages: [] });
  }

  static start(input: RunStartInput): Run {
    if (!(PROVIDERS as readonly string[]).includes(input.provider)) {
      throw new TypeError(`Unknown provider: ${input.provider}`);
    }
    return new Run({
      id: input.id,
      projectId: input.projectId,
      provider: input.provider,
      task: input.task.value,
      startCommit: input.startCommit,
      remoteUrl: input.remoteUrl,
      createdAt: input.now,
      ...RunLifecycle.start().toData(),
      ...RunDelivery.start(input.integrationBranch).toData(),
      ...RunWorkerClaim.none().toData(),
      ...RunProgress.start(input.limits, input.now).toData(),
      messages: [],
      workingCopy: null,
      failingChecks: [],
      pullRequestStatus: RunPullRequestStatus.none().toData(),
    });
  }

  /** Throws {@link TypeError} for state the store should never hold. */
  static restore(data: RunData): Run {
    return new Run(data);
  }

  pendingChanges(): RunChanges {
    const pending = CHANGES.get(this)!;
    return {
      ...pending,
      fields: { ...pending.fields },
      messages: [...pending.messages],
      ...(pending.steps === undefined ? {} : { steps: [...pending.steps] }),
      ...(pending.followUpEntry === undefined
        ? {}
        : { followUpEntry: { ...pending.followUpEntry } }),
    };
  }

  /** The facts {@link HandOutRule} decides on. */
  handOutView(): HandOutView {
    return {
      id: this.id,
      projectId: this.projectId,
      state: this.lifecycle.state,
      claimedBy: this.claim.claimedBy,
      sessionRef: this.claim.sessionRef,
      followUpQueued: this.progress.followUpQueued,
      deliveryRequested: this.delivery.requested,
      lastClaimedBy: this.claim.lastClaimedBy,
      createdAt: this.createdAt,
    };
  }

  /**
   * The store selects the Run under the claim lock. Throws {@link IllegalRunTransitionError} when
   * the worker may not take it. A failed Run held for a delivery retry only changes its holder.
   */
  claimBy(workerId: string, now: Date): void {
    const { state } = this.lifecycle;
    if (!HandOutRule.for(workerId).takes(this.handOutView())) {
      throw new IllegalRunTransitionError(state, 'preparing');
    }
    if (state !== 'queued') {
      this.apply({ claimedBy: workerId, heartbeatAt: now });
      return;
    }
    this.lifecycle.assertTransitionTo('preparing');
    this.apply({
      state: 'preparing',
      claimedBy: workerId,
      lastClaimedBy: workerId,
      // A resumed Run keeps its first start.
      startedAt: this.lifecycle.startedAt ?? now,
      heartbeatAt: now,
      followUpQueued: false,
    });
  }

  /** What the worker that claimed this Run gets, or why the Run cannot be handed out. */
  handOut(): RunHandOut {
    const reachable = this.remoteUrl !== '' && this.delivery.integrationBranch !== '';
    const { workingCopy } = this;
    const pullRequest = this.delivery.pullRequest
      ? { pullRequestNumber: this.delivery.pullRequest.number }
      : {};
    const merged = this.conversation.latestMergedCommit();
    // A delivery retry after a bring-up part counts from the commit it merged, which is not
    // recorded as merged until the part succeeds.
    const counted = this.conversation.currentUpdateStart()?.updateTip ?? merged;
    const mergedBase = counted === undefined ? {} : { mergedIntegrationCommit: counted };
    if (this.lifecycle.state === 'failed') {
      if (!reachable || !workingCopy) {
        return { kind: 'refused', failure: NOT_DELIVERABLE, as: 'delivery' };
      }
      return { kind: 'deliver', runBranch: workingCopy.runBranch, ...mergedBase, ...pullRequest };
    }
    const resume = this.resumeMessage();
    const { sessionRef } = this.claim;
    if (resume !== null && sessionRef !== null) {
      // A Working copy the worker reported removed cannot be resumed.
      if (!reachable || !workingCopy || this.claim.workingCopyRemoved) {
        const failure = this.claim.workingCopyRemoved ? WORKING_COPY_REMOVED : NOT_RESUMABLE;
        return { kind: 'refused', failure, as: 'preparation' };
      }
      // A merge an earlier bring-up part left behind is undone by the next part.
      const pending = this.conversation.pendingUpdate(this.delivery.pushedCommit);
      const update = this.conversation.currentUpdateStart();
      const { followUpCount } = this.progress;
      return {
        kind: 'resume',
        runBranch: workingCopy.runBranch,
        sessionRef,
        answer: resume.text,
        reason: resume.reason,
        newEnvironmentFile: resume.takesNewEnvironmentFile(followUpCount),
        ...mergedBase,
        ...(pending === undefined ? {} : { pendingUpdate: pending }),
        ...(followUpCount > 0 ? { followUpNumber: followUpCount } : {}),
        ...(update === undefined ? {} : { bringUpToDate: update }),
        ...pullRequest,
      };
    }
    if (!reachable) return { kind: 'refused', failure: NO_REMOTE, as: 'preparation' };
    return { kind: 'start' };
  }

  get isResumable(): boolean {
    return this.lifecycle.state === 'queued' && this.resumeMessage() !== null;
  }

  resumeMessage(): RunResume | null {
    return this.conversation.resumeMessage(this.claim.hasSession);
  }

  /** What names the pull request on the Git host; `null` while the pull request or the Run branch is unknown. */
  get hostPullRequest(): { runBranch: string; pullRequestNumber: number } | null {
    if (this.delivery.pullRequest === null || this.workingCopy === null) return null;
    return {
      runBranch: this.workingCopy.runBranch,
      pullRequestNumber: this.delivery.pullRequest.number,
    };
  }

  /** Working, waiting, or about to work again: nothing may be closed under it. */
  get isActive(): boolean {
    return (
      !this.lifecycle.isFinal ||
      this.claim.isHeld ||
      this.delivery.requested ||
      this.progress.followUpQueued
    );
  }

  /** The lookup is limited to the Run branch, so it must be known. */
  canRefreshPullRequest(): boolean {
    return this.delivery.hasPullRequest && this.workingCopy !== null;
  }

  /** The Run branch a merge review fetches: known once an agent worker reported the Working copy. */
  get runBranch(): string | null {
    return this.workingCopy?.runBranch ?? null;
  }

  /**
   * A merge review needs a pull request and a known Run branch, and a pull request that is not
   * merged, closed or missing (a draft one is fine, and so is one not read yet).
   */
  mergeReviewRefusal(): 'no_pull_request' | 'pull_request_not_open' | null {
    if (!this.delivery.hasPullRequest || this.runBranch === null) return 'no_pull_request';
    return isEndedPullRequestState(this.pullRequestStatus.state) ? 'pull_request_not_open' : null;
  }

  /**
   * The newest commit of the Run branch Studio knows of: the one the Run pushed, or the pull
   * request's head from the latest lookup when that was read after the Run last finished.
   */
  latestKnownHead(): string | null {
    const pushed = this.delivery.pushedCommit;
    const { checks, refreshedAt } = this.pullRequestStatus;
    const looked = checks === null || checks.unavailable ? null : checks.commit;
    if (looked === null || refreshedAt === null) return pushed;
    if (pushed === null) return looked;
    const finishedAt = this.lifecycle.finishedAt;
    const lookupIsNewer = finishedAt === null || refreshedAt.getTime() >= finishedAt.getTime();
    return lookupIsNewer ? looked : pushed;
  }

  get resumable(): boolean {
    return (
      this.lifecycle.stoppedAtUsageLimit &&
      this.claim.hasSession &&
      this.workingCopy !== null &&
      !this.lifecycle.cancelRequested
    );
  }

  get openQuestion(): RunQuestion | null {
    const last = this.conversation.messages.at(-1);
    return this.lifecycle.state === 'waiting_for_operator' && last?.kind === 'question'
      ? last.question
      : null;
  }

  /**
   * Whether each commit of the Working copy is on the remote Run branch, in order; `null` without
   * a Working copy, or when the pushed commit is not among the listed ones.
   */
  commitsPushed(): readonly boolean[] | null {
    if (this.workingCopy === null) return null;
    const { pushedCommit } = this.delivery;
    const pushedUpTo = this.workingCopy.commits.findIndex((commit) => commit.id === pushedCommit);
    if (pushedCommit !== null && pushedUpTo === -1) return null;
    return this.workingCopy.commits.map((_commit, index) => index <= pushedUpTo);
  }

  /** Throws {@link RunNotWaitingError} unless the Run waits for an answer to an open question. */
  answer(text: string, now: Date): void {
    if (this.openQuestion === null) {
      throw new RunNotWaitingError(this.lifecycle.state);
    }
    this.lifecycle.assertTransitionTo('queued');
    this.append({ kind: 'answer', text, at: now });
    this.apply({ state: 'queued', waitingSince: null, lastActivityAt: now });
  }

  /**
   * A held Run only gets a cancel request (the first one's time is kept): the worker stops it and
   * reports `cancelled`. Throws {@link RunAlreadyFinishedError} for a finished Run.
   */
  cancel(now: Date): void {
    const { state } = this.lifecycle;
    if (this.lifecycle.isFinal) throw new RunAlreadyFinishedError(state);
    if (state === 'queued' || state === 'waiting_for_operator') {
      this.lifecycle.assertTransitionTo('cancelled');
      this.apply({
        state: 'cancelled',
        cancellation: { ...RunCancellation.OPERATOR },
        waitingSince: null,
        finishedAt: now,
        followUpQueued: false,
      });
      return;
    }
    if (!this.lifecycle.cancelRequested) this.apply({ cancelRequestedAt: now });
  }

  /** Throws {@link DeliveryNotRetryableError} unless the Run is `failed` with `delivery_failed`. */
  requestDeliveryRetry(): void {
    if (!this.lifecycle.canRetryDelivery) throw new DeliveryNotRetryableError();
    if (!this.delivery.requested) this.apply({ deliveryRequested: true });
  }

  /**
   * A queued Run with a session reference holds a place, so it is refused while the places are
   * taken. Throws {@link RunNotResumableError} or {@link RunSlotTakenError}.
   */
  resumeAfterUsageLimit(now: Date, facts: ResumeFacts): void {
    if (
      !this.resumable ||
      // The resumed step's log is redacted with the Environment file snapshot; a Run in a
      // Follow-up works without it.
      (this.claim.environmentFileSupplied &&
        !facts.environmentFileSnapshotKept &&
        !this.progress.inFollowUp)
    ) {
      throw new RunNotResumableError();
    }
    if (facts.projectPlaceTaken) throw new RunSlotTakenError('project');
    if (facts.serverPlacesTaken >= HandOutRule.MAX_PLACES)
      throw new RunSlotTakenError('server', HandOutRule.MAX_PLACES);
    this.append({ kind: 'answer', text: RunConversation.USAGE_LIMIT_RESUME_TEXT, at: now });
    this.apply({ state: 'queued', failure: null, finishedAt: null, lastActivityAt: now });
  }

  followUpFacts(workers: WorkerFacts, now: Date, leaseSeconds: number): FollowUpFacts {
    const provider = WorkerPresence.of(workers.latest, Lease.ofSeconds(leaseSeconds))
      .providerAvailability(now)
      .find((candidate) => candidate.id === this.provider);
    return {
      workerAvailable: Lease.ofSeconds(leaseSeconds).covers(workers.holderLastSeen, now),
      providerAvailable: provider?.available === true,
    };
  }

  followUpAvailability(workers: WorkerFacts, now: Date, leaseSeconds: number): FollowUpEligibility {
    return this.followUpEligibility(this.followUpFacts(workers, now, leaseSeconds));
  }

  followUpEligibility(facts: FollowUpFacts): FollowUpEligibility {
    const refuse = (reason: FollowUpRefusal): FollowUpEligibility => ({ allowed: false, reason });
    if (this.progress.followUpQueued) return refuse('follow_up_queued');
    if (!this.lifecycle.isFinal || this.claim.isHeld || this.delivery.requested) {
      return refuse('not_finished');
    }
    // Nothing to update once the pull request is over; a reopened one is open again
    // at the next lookup.
    const ended = this.pullRequestStatus.followUpRefusal;
    if (ended !== null) return refuse(ended);
    if (!this.claim.hasSession) return refuse('no_session');
    if (this.workingCopy === null || this.claim.workingCopyRemoved) {
      return refuse('working_copy_removed');
    }
    if (this.progress.reachedStepTotal) return refuse('step_total_reached');
    if (!facts.workerAvailable) return refuse('worker_unavailable');
    if (!facts.providerAvailable) return refuse('provider_unavailable');
    return { allowed: true };
  }

  retentionFacts(): RetentionFacts {
    return {
      state: this.lifecycle.state,
      finishedAt: this.lifecycle.finishedAt,
      hasPullRequest: this.delivery.hasPullRequest,
      pullRequestState: this.pullRequestStatus.state,
      pullRequestEndedAt: this.pullRequestStatus.endedAt,
      lastActivityAt: this.progress.lastActivityAt,
    };
  }

  snapshotFacts(): EnvironmentFileSnapshotFacts {
    return {
      isFinal: this.lifecycle.isFinal,
      keepsForRetry: this.lifecycle.keepsEnvironmentFileForRetry,
      deliveryRequested: this.delivery.requested,
      finishedAt: this.lifecycle.finishedAt,
    };
  }

  /**
   * A retryable Run keeps its snapshot: its retention period has just begun.
   */
  releasesEnvironmentFileAfterReport(): boolean {
    return (
      this.claim.environmentFileSupplied &&
      this.lifecycle.isFinal &&
      !this.lifecycle.keepsEnvironmentFileForRetry
    );
  }

  limitedRunFacts(): LimitedRunFacts {
    return {
      state: this.lifecycle.state,
      finishedAt: this.lifecycle.finishedAt,
      hasPullRequest: this.delivery.hasPullRequest,
      hasWorkingCopy: this.workingCopy !== null,
      workingCopyRemoved: this.claim.workingCopyRemoved,
    };
  }

  pullRequestRefreshFacts(): PullRequestRefreshFacts {
    return {
      id: this.id,
      hasPullRequest: this.delivery.hasPullRequest,
      hasWorkingCopy: this.workingCopy !== null,
      refreshRequestedAt: this.pullRequestStatus.refreshRequestedAt,
      pullRequestState: this.pullRequestStatus.state,
      lastAttemptAt: this.pullRequestStatus.lastAttemptAt,
      refreshedAt: this.pullRequestStatus.refreshedAt,
    };
  }

  sweepFacts(): RunSweepFacts {
    return {
      state: this.lifecycle.state,
      claimedBy: this.claim.claimedBy,
      heartbeatAt: this.claim.heartbeatAt,
      stepStartedAt: this.progress.stepStartedAt,
      waitingSince: this.progress.waitingSince,
      limits: this.progress.limits,
      deliveryRequested: this.delivery.requested,
      sessionRef: this.claim.sessionRef,
    };
  }

  /**
   * Throws {@link FollowUpNotAllowedError}, or {@link ReviewCommentsNotLoadedError} when the
   * selected comments are not all loaded. Returns what the caller removes in the same transaction.
   */
  followUp(
    text: string,
    now: Date,
    facts: FollowUpFacts,
    origin?: FollowUpOrigin,
  ): FollowUpConsumption | undefined {
    const eligibility = this.followUpEligibility(facts);
    if (!eligibility.allowed) throw new FollowUpNotAllowedError(eligibility.reason);
    const source = typeof origin === 'object' ? origin.source : origin;
    let comments: { count: number; authors: string[] } | undefined;
    if (typeof origin === 'object') {
      if (origin.comments === null || origin.comments.count === 0) {
        throw new ReviewCommentsNotLoadedError();
      }
      comments = origin.comments;
    }
    this.append({
      kind: 'part_end',
      ...this.lifecycle.partEnd(this.delivery.state)!,
      at: now,
    });
    this.append({
      kind: 'follow_up',
      text,
      at: now,
      ...(source === undefined ? {} : { source }),
      ...(comments === undefined ? {} : { sourceComments: comments }),
    });
    // The Run's state reflects its latest result, so the earlier one is cleared.
    this.apply({
      state: 'queued',
      lastActivityAt: now,
      followUpQueued: true,
      followUpCount: this.progress.followUpCount + 1,
      stepsBeforePart: this.progress.stepCount,
      failure: null,
      finishedAt: null,
      cancellation: null,
      cancelRequestedAt: null,
      delivery: null,
      waitingSince: null,
      stepStartedAt: null,
    });
    return source === undefined || source === 'bring_up_to_date' ? undefined : source;
  }

  /**
   * `false` for a repeat of a report that already applied (the worker retried it). Throws
   * {@link RunNotHeldError} or {@link IllegalRunTransitionError}.
   */
  reportState(workerId: string, report: RunStateReport, now: Date): boolean {
    if (report.unchanged) {
      return this.reportUnchanged(
        workerId,
        report.unchangedDetail ?? this.delivery.alreadyUpToDateDetail,
        now,
      );
    }
    const { state } = this.lifecycle;
    if (state === 'failed' && this.delivery.requested && this.claim.isHeldBy(workerId)) {
      return this.reportDeliveryRetry(workerId, report, now);
    }
    // A cancel request turns a Run step that ended waiting for the operator into `cancelled`, so
    // the operator's cancel holds. A `succeeded` report stays: it carries its delivery.
    const cancelRequested = this.lifecycle.cancelRequested;
    const to: RunState =
      cancelRequested && report.state === 'waiting_for_operator' ? 'cancelled' : report.state;
    // Already applied by an earlier delivery from this worker: nothing to change.
    if (state === to && this.claim.isReportedBy(workerId)) return false;
    if (!this.claim.isHeldBy(workerId)) throw new RunNotHeldError();
    if (to === 'cancelled' && !cancelRequested) throw new IllegalRunTransitionError(state, to);
    this.lifecycle.assertTransitionTo(to);
    if (report.bringUpToDateStarted && to === 'running') {
      this.recordUpdateStart(workerId, report.bringUpToDateStarted);
    }
    const held = isClaimedRunState(to);
    const keepsWorkingCopy = to === 'failed' || to === 'cancelled' || to === 'timed_out';
    // A cancel that arrived during the delivery keeps what was delivered.
    const delivery = to === 'succeeded' || to === 'cancelled' ? (report.delivery ?? null) : null;
    const failure = to === 'failed' ? report.failure : null;
    const pushedCommit =
      report.failure?.code === 'delivery_failed' ? (report.pushedCommit ?? null) : null;
    this.apply({
      state: to,
      failure,
      claimedBy: held ? workerId : null,
      heartbeatAt: held ? now : null,
      cancellation:
        to !== 'cancelled'
          ? null
          : report.delivery?.outcome === 'none' && report.delivery.branchPushed
            ? { ...RunCancellation.OPERATOR_BRANCH_PUSHED }
            : { ...RunCancellation.OPERATOR },
      waitingSince: to === 'waiting_for_operator' ? now : null,
      releasedBy: held ? null : workerId,
      ...(to === 'running' ? { stepStartedAt: now } : {}),
      ...(isFinalRunState(to) ? { finishedAt: now } : {}),
      ...(keepsWorkingCopy && report.workingCopy ? { workingCopy: report.workingCopy } : {}),
      ...(delivery ? this.delivery.outcomePatch(delivery) : {}),
      ...(failure?.code === 'delivery_failed' ? { delivery: 'failed' as const } : {}),
      // A delivery that pushed before it failed still records the push.
      ...(pushedCommit ? { pushedCommit } : {}),
      ...(to === 'failed' && failure?.code === 'usage_limit' && report.sessionRef
        ? { sessionRef: report.sessionRef }
        : {}),
    });
    if (to === 'succeeded') this.recordMergedCommit();
    return true;
  }

  private reportDeliveryRetry(workerId: string, report: RunStateReport, now: Date): boolean {
    const delivery = report.state === 'succeeded' && report.delivery ? report.delivery : null;
    const failure =
      report.state === 'failed' && report.failure?.code === 'delivery_failed'
        ? report.failure
        : null;
    if (!delivery && !failure) {
      throw new IllegalRunTransitionError(this.lifecycle.state, report.state);
    }
    this.apply({
      // A retried report of this outcome is then recognised.
      ...this.released(workerId, now),
      deliveryRequested: false,
      ...(report.workingCopy ? { workingCopy: report.workingCopy } : {}),
      ...(delivery
        ? { state: 'succeeded' as const, failure: null, ...this.delivery.outcomePatch(delivery) }
        : {
            failure: failure!,
            delivery: 'failed' as const,
            ...(report.pushedCommit ? { pushedCommit: report.pushedCommit } : {}),
          }),
    });
    if (delivery) this.recordMergedCommit();
    return true;
  }

  /** `false` for a repeat of a report that already applied. */
  private reportUnchanged(workerId: string, detail: string, now: Date): boolean {
    if (!this.claim.isHeldBy(workerId)) {
      if (this.claim.releasedBy === workerId && this.lifecycle.isFinal) return false;
      throw new RunNotHeldError();
    }
    const before = this.conversation.partEndBeforeBringUp;
    if (!isClaimedRunState(this.lifecycle.state) || before === undefined) {
      throw new IllegalRunTransitionError(this.lifecycle.state, 'succeeded');
    }
    // Nothing was changed: the Run is as it was, and its conversation says so.
    this.append({
      kind: 'part_end',
      state: before.state,
      failureCode: before.failureCode,
      delivery: before.delivery,
      detail,
      at: now,
    });
    this.apply({
      ...EarlierResult.of(before).toData(),
      delivery: before.delivery,
      ...this.released(workerId, now),
      stepStartedAt: null,
    });
    return true;
  }

  /**
   * `false` when nothing was recorded: not held by `workerId`, or the Follow-up
   * has a start already.
   */
  recordUpdateStart(
    workerId: string,
    start: { baseCommit: string; integrationCommit: string },
  ): boolean {
    if (!this.claim.isHeldBy(workerId) || !this.conversation.canRecordUpdateStart) return false;
    this.updateFollowUpEntry({ updateBase: start.baseCommit, updateTip: start.integrationCommit });
    return true;
  }

  /** Idempotent; `false` when there was nothing to record. */
  recordMergedCommit(): boolean {
    const merged = this.conversation.mergeToRecord;
    if (merged === undefined) return false;
    this.updateFollowUpEntry({ mergedCommit: merged });
    return true;
  }

  /**
   * A retried step (same number) is acknowledged without storing it again; a step beyond the
   * allowance fails the Run with `step_limit`. Throws {@link RunNotHeldError} or
   * {@link StepOutOfOrderError}, changing nothing.
   */
  reportStep(
    workerId: string,
    step: RunStepRecord,
    workingCopy: RunWorkingCopy,
    failingChecks: readonly string[],
    now: Date,
  ): RunStepOutcome {
    if (this.lifecycle.state !== 'running' || !this.claim.isHeldBy(workerId)) {
      throw new RunNotHeldError();
    }
    const last = this.progress.stepCount;
    const index = step.index ?? last + 1;
    if (index <= last) return { status: 'stored', index, duplicate: true };
    if (index !== last + 1) throw new StepOutOfOrderError(last + 1);
    if (!this.progress.allowsStep(index)) {
      this.apply({
        state: 'failed',
        failure: this.progress.stepLimitFailure(),
        ...this.released(null, now),
      });
      return { status: 'step_limit' };
    }
    // The Run creates its step: the step cannot exist without the Run, and the number and the
    // limit above are the Run's to check from `stepCount`, so no other step is loaded for them.
    const pending = CHANGES.get(this)!;
    const created = RunStep.create({ index, kind: step.kind, result: step.result });
    pending.steps = [...(pending.steps ?? []), created];
    if (step.question) this.append({ kind: 'question', question: step.question, at: now });
    this.apply({
      stepCount: index,
      workingCopy,
      failingChecks: [...failingChecks],
      // The step is over: the time-limit backstop no longer runs for it, so a slow delivery after
      // it is never timed out.
      stepStartedAt: null,
      lastActivityAt: now,
      ...(step.sessionRef === undefined ? {} : { sessionRef: step.sessionRef }),
    });
    return { status: 'stored', index };
  }

  /** Throws {@link RunNotHeldError} when this worker does not hold the Run. */
  recordHeartbeat(workerId: string, now: Date): { cancelRequested: boolean } {
    if (!this.claim.isHeldBy(workerId)) throw new RunNotHeldError();
    this.apply({ heartbeatAt: now });
    return { cancelRequested: this.lifecycle.cancelRequested };
  }

  /**
   * Recorded only for a Run the worker last claimed and does not hold (also one queued for a
   * Follow-up meanwhile), and only once. `false` when nothing was recorded.
   */
  reportWorkingCopyRemoved(workerId: string, now: Date): boolean {
    if (
      !this.claim.wasLastClaimedBy(workerId) ||
      this.claim.isHeld ||
      this.claim.workingCopyRemoved
    ) {
      return false;
    }
    this.apply({ workingCopyRemovedAt: now });
    return true;
  }

  /**
   * `null` when the Project has no Environment file now. Throws {@link RunNotHeldError} when the
   * Run is no longer `preparing` or held by this worker.
   */
  recordEnvironmentFile(workerId: string, file: { path: string; secretRef: string } | null): void {
    if (this.lifecycle.state !== 'preparing' || !this.claim.isHeldBy(workerId)) {
      throw new RunNotHeldError();
    }
    this.apply({ environmentFileSupplied: file !== null, environmentFilePath: file?.path ?? null });
    CHANGES.get(this)!.environmentFileSecretRef = file?.secretRef ?? null;
  }

  /** `false` when the Run is not `preparing` and held by `workerId`, or has a cancel request. */
  failPreparation(workerId: string, failure: RunFailure, now: Date): boolean {
    if (
      this.lifecycle.state !== 'preparing' ||
      !this.claim.isHeldBy(workerId) ||
      this.lifecycle.cancelRequested
    ) {
      return false;
    }
    this.apply({
      state: 'failed',
      failure,
      ...this.released(workerId, now),
      waitingSince: null,
    });
    return true;
  }

  /**
   * For Studio's own sweep, not the operator's cancel. `false` when the Run no longer waits (an
   * answer or the operator's cancel came first). Does not set `lastActivityAt`.
   */
  cancelAfterWaiting(cancellation: RunCancellation, now: Date): boolean {
    if (this.lifecycle.state !== 'waiting_for_operator') return false;
    this.lifecycle.assertTransitionTo('cancelled');
    this.apply({
      state: 'cancelled',
      cancellation: { ...cancellation },
      waitingSince: null,
      finishedAt: now,
      followUpQueued: false,
    });
    return true;
  }

  /** `false` when the retry is not pending or a worker holds the Run. */
  abandonDeliveryRetry(failure: RunFailure, now: Date): boolean {
    if (this.lifecycle.state !== 'failed' || !this.delivery.requested || this.claim.isHeld) {
      return false;
    }
    this.apply({ failure, delivery: 'failed', deliveryRequested: false, finishedAt: now });
    return true;
  }

  /**
   * `queued` to `failed` is an exception the Run applies itself, like
   * {@link Run.resumeAfterUsageLimit}: it is not in the lifecycle's transitions, so a worker's
   * report cannot do it. `false` when the Run is not a queued resume.
   */
  abandonResume(failure: RunFailure, now: Date): boolean {
    if (this.lifecycle.state !== 'queued' || !this.claim.hasSession) return false;
    this.apply({ state: 'failed', failure, finishedAt: now, followUpQueued: false });
    return true;
  }

  /** Reading Review comments marks nothing on the Run. */
  recordLookupRequested(kind: LookupKind, now: Date): void {
    if (kind === 'pull_request_state') {
      this.updateStatus(this.pullRequestStatus.refreshRequested(now));
    } else if (kind === 'failing_check_logs') {
      this.updateStatus(this.pullRequestStatus.preparationRequested(now));
    }
  }

  /** A Run without a pull request is left alone. */
  recordPullRequestState(result: PullRequestStateResult, now: Date): void {
    if (!this.delivery.hasPullRequest) return;
    this.updateStatus(this.pullRequestStatus.read(result, now));
  }

  recordPreparationDone(): void {
    this.updateStatus(this.pullRequestStatus.preparationDone());
  }

  /**
   * With a retry (`retryAt`, a rate limit) the Run stays refreshing or preparing until then.
   * Reading Review comments marks nothing.
   */
  recordLookupFailed(
    kind: LookupKind,
    error: string,
    retryAt: Date | null,
    requestedAt: Date,
  ): void {
    if (kind === 'pull_request_state') {
      this.updateStatus(this.pullRequestStatus.refreshFailed(error, retryAt, requestedAt));
    } else if (kind === 'failing_check_logs') {
      this.updateStatus(this.pullRequestStatus.preparationFailed(error, retryAt, requestedAt));
    }
  }

  /**
   * Claims the close or the deletion after it (`done`: none). `resume_close`: an earlier attempt
   * died holding the claim. Throws {@link ClosePullRequestRefusedError} or {@link CloseInProgressError}.
   */
  claimClose(now: Date): 'close' | 'resume_close' | 'delete_branch' | 'done' {
    if (this.isActive) throw new ClosePullRequestRefusedError('run_active');
    if (this.hostPullRequest === null) {
      throw new ClosePullRequestRefusedError('pull_request_not_open');
    }
    const status = this.pullRequestStatus;
    const progress = status.closeProgress;
    if (progress === 'complete') return 'done';
    if (status.isCloseClaimed(now)) throw new CloseInProgressError();
    this.updateStatus(status.closeClaimed(now));
    if (progress === 'branch_pending') return 'delete_branch';
    return status.closeClaimedAt === null ? 'close' : 'resume_close';
  }

  releaseCloseClaim(): void {
    this.updateStatus(this.pullRequestStatus.closeReleased());
  }

  recordClosedFromStudio(now: Date): void {
    this.updateStatus(this.pullRequestStatus.closedFromStudio(now));
  }

  recordBranchDeleted(now: Date): void {
    this.updateStatus(this.pullRequestStatus.branchDeleted(now));
  }

  /** `reason` is the host's, redacted. */
  recordBranchDeletionFailed(reason: string): void {
    this.updateStatus(this.pullRequestStatus.branchDeletionFailed(reason));
  }

  /** A Run without a pull request is left alone. */
  recordObservedPullRequestState(state: PullRequestState, now: Date): void {
    if (!this.delivery.hasPullRequest) return;
    this.updateStatus(this.pullRequestStatus.observed(state, now));
  }

  /**
   * Throws {@link RunNotHeldError} unless the worker holds the Run, also `failed`
   * for a delivery retry.
   */
  assertDiffReportableBy(workerId: string): void {
    const held =
      isClaimedRunState(this.lifecycle.state) ||
      (this.lifecycle.state === 'failed' && this.delivery.requested);
    if (!held || !this.claim.isHeldBy(workerId)) throw new RunNotHeldError();
  }

  private released(by: string | null, now: Date): RunPatch {
    return { claimedBy: null, heartbeatAt: null, releasedBy: by, finishedAt: now };
  }

  private updateStatus(next: RunPullRequestStatus): void {
    this.apply({ pullRequestStatus: next.toData() });
  }

  private updateFollowUpEntry(details: BringUpDetails): void {
    const conversation = this.conversation.withFollowUpDetails(details);
    if (conversation === this.conversation) return;
    Object.assign(this, { conversation });
    const pending = CHANGES.get(this)!;
    pending.followUpEntry = { ...pending.followUpEntry, ...details };
  }

  /**
   * Records the patch as what the store saves: only the fields an operation changed are written.
   */
  private apply(patch: RunPatch): void {
    Object.assign(this, {
      lifecycle: this.lifecycle.with(patch),
      delivery: this.delivery.with(patch),
      claim: this.claim.with(patch),
      progress: this.progress.with(patch),
      ...(patch.pullRequestStatus === undefined
        ? {}
        : { pullRequestStatus: RunPullRequestStatus.restore(patch.pullRequestStatus) }),
      ...(patch.workingCopy === undefined ? {} : { workingCopy: patch.workingCopy }),
      ...(patch.failingChecks === undefined ? {} : { failingChecks: patch.failingChecks }),
    });
    Object.assign(CHANGES.get(this)!.fields, patch);
  }

  private append(message: RunMessage): void {
    CHANGES.get(this)!.messages.push(message);
    Object.assign(this, { conversation: this.conversation.append(message) });
  }
}
