import type { RunSnapshot } from '../value-objects/run-snapshot.js';
import { HandOutRule } from '../value-objects/hand-out-rule.js';
import type { FollowUpEligibility, FollowUpRefusal } from '../value-objects/follow-up.js';
import { PROVIDERS } from '../value-objects/provider.js';
import { RunConversation, type BringUpDetails } from '../value-objects/run-conversation.js';
import type { RunMessage } from '../value-objects/run-conversation.js';
import type { RunData } from '../value-objects/run-data.js';
import { RunDelivery } from '../value-objects/run-delivery.js';
import {
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
} from '../value-objects/run-errors.js';
import type { RunFailure } from '../value-objects/run-failure.js';
import type {
  FollowUpConsumption,
  FollowUpFacts,
  FollowUpOrigin,
  ResumeFacts,
  RetentionFacts,
  RunChanges,
  RunStartInput,
  RunStateReport,
  RunStepOutcome,
  RunStepRecord,
  WorkerFacts,
} from '../value-objects/run-facts.js';
import { RunLifecycle } from '../value-objects/run-lifecycle.js';
import { RunProgress } from '../value-objects/run-progress.js';
import {
  RunPullRequestStatus,
  type PullRequestState,
  type PullRequestStateResult,
} from '../value-objects/run-pull-request-status.js';
import type { RunResume } from '../value-objects/run-resume.js';
import { isClaimedRunState, isFinalRunState, type RunState } from '../value-objects/run-state.js';
import {
  OPERATOR_CANCELLATION,
  OPERATOR_CANCELLATION_BRANCH_PUSHED,
} from '../value-objects/run-cancellation.js';
import { RunWorkerClaim } from '../value-objects/run-worker-claim.js';
import type { RunWorkingCopy } from '../value-objects/run-working-copy.js';
import { WorkerStatus } from '../value-objects/worker-status.js';
import { RunStep } from './run-step.js';
import type { RunStepSnapshot } from '../value-objects/run-step-snapshot.js';

/** The stored fields an operation of the Run changes: the flat names, as storage holds them. */
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

const CHANGES = new WeakMap<Run, RunChanges>();

/**
 * The Run (Issue #96): one Task carried out by a Provider on one Project, from a recorded commit
 * of the integration branch. It keeps its identity and one value object per concept that is part
 * of it: its lifecycle, delivery, pull request status, conversation, worker claim and progress
 * (the Working copy and the reported failing checks are plain values). The value objects own the
 * rules about their concept and are immutable: a change replaces the Run's field with a new
 * value. The Run owns what spans concepts.
 *
 * It owns the rules of what the operator can do with it: answer the agent's question, send a
 * Follow-up, cancel, retry a failed delivery and resume after the usage limit (Issue #167). Each
 * is a method that checks its preconditions against the Run's own state and the facts passed in,
 * refuses with a domain error otherwise, and records what changed. The store saves
 * {@link Run.pendingChanges} in one transaction under the Run's row lock, so two simultaneous
 * requests cannot both succeed. What the agent worker reports for the Run (a state, a Run step, a
 * heartbeat, the removal of its Working copy, its Environment file; Issue #169) is a method too,
 * which also checks that the reporting worker holds the Run; only the hand-out of the next Run
 * and the sweeps over many Runs stay in the store, each with a named rule.
 *
 * Change tracking is per stored field: every operation applies a patch of the flat fields it
 * changed, which the Run both applies to its value objects and records, so a save writes only
 * those columns.
 *
 * It cannot be built in an invalid state: only {@link Run.start} and {@link Run.restore} make
 * one. Its fields are readable and never assigned from outside.
 */
export class Run {
  declare readonly id: RunData['id'];
  declare readonly projectId: RunData['projectId'];
  declare readonly provider: RunData['provider'];
  declare readonly task: RunData['task'];
  /** The integration branch's commit when the Run was started. */
  declare readonly startCommit: RunData['startCommit'];
  /** The Repository's remote URL when the Run was started (Issue #98); never a credential. */
  declare readonly remoteUrl: RunData['remoteUrl'];
  declare readonly createdAt: RunData['createdAt'];
  declare readonly lifecycle: RunLifecycle;
  declare readonly delivery: RunDelivery;
  declare readonly pullRequestStatus: RunPullRequestStatus;
  declare readonly conversation: RunConversation;
  declare readonly claim: RunWorkerClaim;
  declare readonly progress: RunProgress;
  /** The latest reported Working copy state; `null` until the first Run step is reported. */
  declare readonly workingCopy: RunWorkingCopy | null;
  /** Names of the checks the agent reported failed in the latest Run step. */
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
      workingCopy: data.workingCopy,
      failingChecks: data.failingChecks,
    });
    CHANGES.set(this, { fields: {}, messages: [] });
  }

  /** A new Run, `queued`, for a valid Task (Issue #96); stored by the Run repository. */
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
      ...RunLifecycle.start().toStored(),
      ...RunDelivery.start(input.integrationBranch).toStored(),
      ...RunWorkerClaim.none().toStored(),
      ...RunProgress.start(input.limits, input.now).toStored(),
      messages: [],
      workingCopy: null,
      failingChecks: [],
      pullRequestStatus: RunPullRequestStatus.none().toStored(),
    });
  }

  /** A Run as storage holds it. Throws {@link TypeError} for state the store should never hold. */
  static restore(data: RunData): Run {
    return new Run(data);
  }

  /** What changed since the Run was started or restored; the store saves exactly this. */
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

  /**
   * The Run's current values as read-only plain data, flat as storage holds them (rule 10): what a
   * handler's result carries, so the class itself never leaves the application layer.
   */
  snapshot(): RunSnapshot {
    return {
      id: this.id,
      projectId: this.projectId,
      provider: this.provider,
      task: this.task,
      startCommit: this.startCommit,
      remoteUrl: this.remoteUrl,
      createdAt: this.createdAt,
      ...this.lifecycle.toStored(),
      ...this.delivery.toStored(),
      ...this.claim.toStored(),
      ...this.progress.toStored(),
      ...this.conversation.toStored(),
      workingCopy: this.workingCopy,
      failingChecks: [...this.failingChecks],
      pullRequestStatus: this.pullRequestStatus.toStored(),
    };
  }

  /**
   * Whether the Run waits in the queue to be resumed (Issue #103): the operator answered (or sent
   * a Follow-up, Issue #141), and the agent worker that holds its Working copy has not claimed it.
   */
  get isResumable(): boolean {
    return this.lifecycle.state === 'queued' && this.resumeMessage() !== null;
  }

  /** The message that resumes the Run's agent session, and why; `null` when none does. */
  resumeMessage(): RunResume | null {
    return this.conversation.resumeMessage(this.claim.hasSession);
  }

  /**
   * Whether the Run's pull request can be looked up: it has one, and its Run branch is known (the
   * lookup is limited to that branch).
   */
  canRefreshPullRequest(): boolean {
    return this.delivery.hasPullRequest && this.workingCopy !== null;
  }

  /**
   * Whether the operator may resume a Run stopped at the usage limit (Issue #105): `failed` with
   * `usage_limit`, with the agent session and the Working copy the worker reported, and no cancel
   * request. It goes back to `queued` and is resumed like an answered Run (same holder rules).
   */
  private get canResumeAfterUsageLimit(): boolean {
    return (
      this.lifecycle.stoppedAtUsageLimit &&
      this.claim.hasSession &&
      this.workingCopy !== null &&
      !this.lifecycle.cancelRequested
    );
  }

  /**
   * The operator answers the agent's open question (Issue #103): the answer is stored after the
   * question and the Run goes back to `queued`, to be resumed by the agent worker that holds its
   * Working copy. Only a `waiting_for_operator` Run whose last message is a question takes an
   * answer; a second answer, or one after a cancel, is refused with {@link RunNotWaitingError}.
   */
  answer(text: string, now: Date): void {
    if (this.lifecycle.state !== 'waiting_for_operator' || !this.conversation.awaitsAnswer) {
      throw new RunNotWaitingError(this.lifecycle.state);
    }
    this.lifecycle.assertTransitionTo('queued');
    this.append({ kind: 'answer', text, at: now });
    this.apply({ state: 'queued', waitingSince: null, lastActivityAt: now });
  }

  /**
   * The operator cancels the Run (Issue #100). A `queued` or `waiting_for_operator` Run (no
   * worker holds it) is `cancelled` at once. A `preparing` or `running` Run only gets a cancel
   * request, its first request's time kept: its state stays until the agent worker, told with its
   * next heartbeat, has stopped and reports `cancelled`. Repeating it changes nothing. Throws
   * {@link RunAlreadyFinishedError} for a finished Run.
   */
  cancel(now: Date): void {
    const { state } = this.lifecycle;
    if (this.lifecycle.isFinal) throw new RunAlreadyFinishedError(state);
    if (state === 'queued' || state === 'waiting_for_operator') {
      this.lifecycle.assertTransitionTo('cancelled');
      this.apply({
        state: 'cancelled',
        cancellation: { ...OPERATOR_CANCELLATION },
        waitingSince: null,
        finishedAt: now,
        followUpQueued: false,
      });
      return;
    }
    if (!this.lifecycle.cancelRequested) this.apply({ cancelRequestedAt: now });
  }

  /**
   * The operator asks to repeat only the delivery of a Run whose delivery failed (Issue #102):
   * the Run stays `failed` and is marked for a retry, which the next claim hands to the worker
   * that holds its Working copy. Repeating the request changes nothing. Throws
   * {@link DeliveryNotRetryableError} unless the Run is `failed` with `delivery_failed`.
   */
  requestDeliveryRetry(): void {
    if (!this.lifecycle.canRetryDelivery) throw new DeliveryNotRetryableError();
    if (!this.delivery.requested) this.apply({ deliveryRequested: true });
  }

  /**
   * The operator resumes a Run stopped at the usage limit (Issue #105): "Continue where you
   * stopped." is stored as the operator's answer and the Run goes back to `queued`, to be resumed
   * like an answered Run by the worker that holds its Working copy (failure and finish time
   * cleared). A queued Run with a session reference holds its Project's place and one of the
   * server's, so it is refused while those are taken (review R1 of #129). Throws
   * {@link RunNotResumableError} (also when a supplied Environment file's snapshot is gone, unless
   * the Run is in a Follow-up, which works without it, Issue #141) or {@link RunSlotTakenError}.
   */
  resumeAfterUsageLimit(now: Date, facts: ResumeFacts): void {
    if (
      !this.canResumeAfterUsageLimit ||
      // The resumed step's log is redacted with the snapshot (Issue #104); a Run in a Follow-up
      // works without it already (Issue #141, coordinator decision 5).
      (this.claim.environmentFileSupplied &&
        !facts.environmentFileSnapshotKept &&
        !this.progress.inFollowUp)
    ) {
      throw new RunNotResumableError();
    }
    if (facts.projectPlaceTaken) throw new RunSlotTakenError('project');
    if (facts.serverPlacesTaken >= HandOutRule.MAX_PLACES) throw new RunSlotTakenError('server');
    this.append({ kind: 'answer', text: RunConversation.USAGE_LIMIT_RESUME_TEXT, at: now });
    this.apply({ state: 'queued', failure: null, finishedAt: null, lastActivityAt: now });
  }

  /**
   * What the Run's Follow-up needs of the agent worker (Issue #141): whether the worker that
   * holds its Working copy has reported within the lease, and whether its Provider is available
   * on the connected worker (the same rule as starting a Run, Issue #101). The facts are values
   * the handler fetched.
   */
  followUpFacts(workers: WorkerFacts, now: Date, leaseSeconds: number): FollowUpFacts {
    const provider = WorkerStatus.providerAvailability(workers.latest, now, leaseSeconds).find(
      (candidate) => candidate.id === this.provider,
    );
    return {
      workerAvailable: WorkerStatus.isWithinLease(workers.holderLastSeen, now, leaseSeconds),
      providerAvailable: provider?.available === true,
    };
  }

  /** Whether the operator may send the Run a Follow-up now, with the reason when not (Issue #141). */
  followUpAvailability(workers: WorkerFacts, now: Date, leaseSeconds: number): FollowUpEligibility {
    return this.followUpEligibility(this.followUpFacts(workers, now, leaseSeconds));
  }

  /**
   * Whether the operator may send the Run a Follow-up (Issue #141): the one way from a final state
   * back to `queued`, next to a delivery retry and a usage-limit resume. A finished Run
   * (succeeded, failed, timed out or cancelled) that no worker holds, whose Working copy and agent
   * session exist, below its Run step total, with its Provider available on the connected agent
   * worker that holds the Working copy. `facts` is what Studio knows about the agent worker now.
   */
  followUpEligibility(facts: FollowUpFacts): FollowUpEligibility {
    const refuse = (reason: FollowUpRefusal): FollowUpEligibility => ({ allowed: false, reason });
    if (this.progress.followUpQueued) return refuse('follow_up_queued');
    if (!this.lifecycle.isFinal || this.claim.isHeld || this.delivery.requested) {
      return refuse('not_finished');
    }
    // Issue #142: nothing to update once the pull request is over; a reopened one is open again
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

  /** What decides how long the Run's Working copy is kept (Issue #143). */
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

  /**
   * The operator sends a Follow-up to the finished Run (Issue #141): how the part before it ended
   * is recorded first (a `part_end` message, review S1 of #150), then `text` as a `follow_up`
   * message, and the Run goes back to `queued` with its earlier result cleared, its pull request
   * kept and a new Run step allowance from the steps it has taken. Eligible as
   * {@link Run.followUpEligibility} says, with `facts` about the agent worker; otherwise
   * {@link FollowUpNotAllowedError}. With an `origin` (Issue #145, #147: the text was prepared
   * from a source) the message says so. Issue #146: a Follow-up from `review_comments` carries what
   * the selection came to in the loaded Review comments (`origin.comments`, as values the caller
   * read under the Run's lock): they must be there and not none (otherwise
   * {@link ReviewCommentsNotLoadedError}), and the message records how many and whose. Returns what
   * the Follow-up used up beyond the Run (the prepared Follow-up of its source, or the loaded
   * Review comments), for the caller to remove in the same transaction that saves the Run.
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
    // Back to the queue (the one way from a final state, next to a delivery retry and a usage
    // limit resume): the Run's state reflects its latest result, so the earlier one is cleared.
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
   * The agent worker holding the Run reports a change of state, with how a succeeded Run was
   * delivered (Issue #102, #96). For a `failed` Run it holds for a delivery retry it reports the
   * retry's outcome: `succeeded` with the delivery, or `failed` with `delivery_failed` again. With
   * a cancel request on the Run (Issue #100) the worker confirms the stop with `cancelled`; a Run
   * step that ended with `waiting_for_operator` before the worker learned of the request also ends
   * the Run as `cancelled`, so the operator's cancel holds. A `cancelled` report without a request
   * is refused. A repeat of the change that already applied (the worker retried a report whose
   * answer it never got) changes nothing and returns `false` (review of #121). A succeeded
   * bring-up-to-date part has its merge in the pushed Run branch (Issue #147). Throws
   * {@link RunNotHeldError} (another worker holds it, or nobody does) or
   * {@link IllegalRunTransitionError}.
   */
  reportState(workerId: string, report: RunStateReport, now: Date): boolean {
    if (report.unchanged) {
      return this.reportUnchanged(
        workerId,
        report.unchangedDetail ??
          RunConversation.alreadyUpToDateDetail(this.delivery.integrationBranch),
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
    // Issue #147: where a bring-up-to-date merge started (only while this worker holds the Run).
    if (report.bringUpToDateStarted && to === 'running') {
      this.recordUpdateStart(workerId, report.bringUpToDateStarted);
    }
    const held = isClaimedRunState(to);
    const keepsWorkingCopy = to === 'failed' || to === 'cancelled' || to === 'timed_out';
    // A cancel that arrived during the delivery keeps what was delivered (review of #121).
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
            ? { ...OPERATOR_CANCELLATION_BRANCH_PUSHED }
            : { ...OPERATOR_CANCELLATION },
      waitingSince: to === 'waiting_for_operator' ? now : null,
      releasedBy: held ? null : workerId,
      ...(to === 'running' ? { stepStartedAt: now } : {}),
      ...(isFinalRunState(to) ? { finishedAt: now } : {}),
      ...(keepsWorkingCopy && report.workingCopy ? { workingCopy: report.workingCopy } : {}),
      ...(delivery ? RunDelivery.outcomePatch(delivery) : {}),
      ...(failure?.code === 'delivery_failed' ? { delivery: 'failed' as const } : {}),
      // Review S2 of #150: a delivery that pushed before it failed still records the push.
      ...(pushedCommit ? { pushedCommit } : {}),
      // Issue #105: the session a Run stopped at the usage limit resumes later.
      ...(to === 'failed' && failure?.code === 'usage_limit' && report.sessionRef
        ? { sessionRef: report.sessionRef }
        : {}),
    });
    if (to === 'succeeded') this.recordMergedCommit();
    return true;
  }

  /**
   * The outcome of a delivery retry: the one way out of `failed` (Issue #102). The worker holding
   * the Run for it reports `succeeded` with the delivery, or `failed` with `delivery_failed`
   * again; either way the Run is released and finished again at `now`, and the request is over.
   */
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
      claimedBy: null,
      heartbeatAt: null,
      // A retried report of this outcome is then recognised (review of #121).
      releasedBy: workerId,
      deliveryRequested: false,
      finishedAt: now,
      ...(report.workingCopy ? { workingCopy: report.workingCopy } : {}),
      ...(delivery
        ? { state: 'succeeded' as const, failure: null, ...RunDelivery.outcomePatch(delivery) }
        : {
            failure: failure!,
            delivery: 'failed' as const,
            ...(report.pushedCommit ? { pushedCommit: report.pushedCommit } : {}),
          }),
    });
    if (delivery) this.recordMergedCommit();
    return true;
  }

  /**
   * A bring-up-to-date request whose branch was already up to date (Issue #147), reported by the
   * worker holding the Run (preparing or running): the Run goes back to the result it had before
   * the request (the state, failure and delivery the `part_end` before the Follow-up recorded) and
   * a `part_end` with `detail` notes that nothing was changed. Nothing was pushed and no Run step
   * was taken. A repeat of the report that already applied changes nothing (`false`).
   */
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
      ...RunLifecycle.earlierResult(before),
      delivery: before.delivery,
      claimedBy: null,
      heartbeatAt: null,
      releasedBy: workerId,
      finishedAt: now,
      stepStartedAt: null,
    });
    return true;
  }

  /**
   * Records where a bring-up-to-date merge started (Issue #147) on the Run's latest Follow-up: the
   * Run branch's commit before it and the integration branch commit being merged, kept for the
   * later claims of the part. Only while `workerId` holds the Run, only when that Follow-up came
   * from the request and has none yet. `false` when nothing was recorded.
   */
  recordUpdateStart(
    workerId: string,
    start: { baseCommit: string; integrationCommit: string },
  ): boolean {
    if (!this.claim.isHeldBy(workerId) || !this.conversation.canRecordUpdateStart) return false;
    this.updateFollowUpEntry({ updateBase: start.baseCommit, updateTip: start.integrationCommit });
    return true;
  }

  /**
   * Once a bring-up-to-date part succeeded (Issue #147): its merge is in the pushed Run branch, so
   * the Follow-up's `updateTip` becomes its `mergedCommit` (what the page shows and what the Run's
   * own changes are counted from). Idempotent; `false` when there was nothing to record.
   */
  recordMergedCommit(): boolean {
    const merged = this.conversation.mergeToRecord;
    if (merged === undefined) return false;
    this.updateFollowUpEntry({ mergedCommit: merged });
    return true;
  }

  /**
   * The agent worker holding a `running` Run reports the structured result of a Run step, numbered
   * 1, 2, … in report order (Issue #96). The Working copy's state it reports becomes the Run's
   * latest (Issue #98), with the checks the agent reported failed (Issue #102); a `needs_input`
   * step's question becomes the Run's next message and the session reference the Run's (Issue
   * #103); the step's clock stops (review of #121). A retried report of a step already stored
   * (same number) is acknowledged without storing it again. A step beyond the allowance of the
   * current part (the first, or a Follow-up, Issue #141) is not stored: the Run is `failed` with
   * `step_limit`, released and finished at `now` (Issue #100), and the outcome says so. Throws
   * {@link RunNotHeldError} (not running, or not held by this worker) or
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
        claimedBy: null,
        heartbeatAt: null,
        finishedAt: now,
      });
      return { status: 'step_limit' };
    }
    // The Run creates its step: the step cannot exist without the Run, and the number and the
    // limit above are the Run's to check from `stepCount`, so no other step is loaded for them.
    const pending = CHANGES.get(this)!;
    const created: RunStepSnapshot = RunStep.create({
      index,
      kind: step.kind,
      result: step.result,
    }).snapshot();
    pending.steps = [...(pending.steps ?? []), created];
    // A question becomes the Run's next message (Issue #103).
    if (step.question) this.append({ kind: 'question', question: step.question, at: now });
    this.apply({
      stepCount: index,
      workingCopy,
      failingChecks: [...failingChecks],
      // The step is over: Studio's time-limit backstop no longer runs for it (review of #121), so
      // a slow delivery after it is never timed out.
      stepStartedAt: null,
      lastActivityAt: now,
      ...(step.sessionRef === undefined ? {} : { sessionRef: step.sessionRef }),
    });
    return { status: 'stored', index };
  }

  /**
   * The agent worker holding the Run says it is still alive, which renews its lease (Issue #96).
   * Tells it whether the operator asked to cancel (Issue #100). Throws {@link RunNotHeldError}
   * when this worker does not hold the Run.
   */
  recordHeartbeat(workerId: string, now: Date): { cancelRequested: boolean } {
    if (!this.claim.isHeldBy(workerId)) throw new RunNotHeldError();
    this.apply({ heartbeatAt: now });
    return { cancelRequested: this.lifecycle.cancelRequested };
  }

  /**
   * The worker's retention removed the Run's Working copy (Issue #141): recorded only for a Run
   * the worker last claimed and does not hold, also one queued for a Follow-up meanwhile (review S9
   * of #150), and only once. `false` when nothing was recorded.
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
   * Records the Project's Environment file the claim gave the `preparing` Run held by `workerId`
   * (Issue #104; a Follow-up, or a usage-limit resume inside one, takes the Project's current file,
   * review S3 of #150): its path in the Working copy and the secret store's reference to its
   * snapshot; or `null` when the Project has none now. Throws {@link RunNotHeldError} when the Run
   * is no longer `preparing` or held by this worker.
   */
  recordEnvironmentFile(workerId: string, file: { path: string; secretRef: string } | null): void {
    if (this.lifecycle.state !== 'preparing' || !this.claim.isHeldBy(workerId)) {
      throw new RunNotHeldError();
    }
    this.apply({ environmentFileSupplied: file !== null, environmentFilePath: file?.path ?? null });
    CHANGES.get(this)!.environmentFileSecretRef = file?.secretRef ?? null;
  }

  /**
   * The claim could not prepare the Run (the Environment file or the repository remote is not
   * there; Issue #104): the Run held by `workerId` in `preparing`, with no cancel request, is
   * `failed` with `failure`, released and finished at `now`. `false` when it is not so held, with
   * no cancel request.
   */
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
      claimedBy: null,
      heartbeatAt: null,
      releasedBy: workerId,
      waitingSince: null,
      finishedAt: now,
    });
    return true;
  }

  /**
   * A lookup of the pull request's state was requested (Issue #142): the Run is refreshing from
   * `now` on, and the attempt counts for the page-open throttle.
   */
  recordRefreshRequested(now: Date): void {
    this.updateStatus(this.pullRequestStatus.refreshRequested(now));
  }

  /**
   * The reading of the failing checks' logs was requested (Issue #145): the Run is preparing from
   * `now` on, the last preparation's error cleared. The state refresh's throttle is left alone.
   */
  recordPreparationRequested(now: Date): void {
    this.updateStatus(this.pullRequestStatus.preparationRequested(now));
  }

  /**
   * What a worker read of the pull request's state replaces what Studio knows (Issues #142, #143,
   * #145), as {@link RunPullRequestStatus.read} says. A Run without a pull request is left alone.
   */
  recordPullRequestState(result: PullRequestStateResult, now: Date): void {
    if (!this.delivery.hasPullRequest) return;
    this.updateStatus(this.pullRequestStatus.read(result, now));
  }

  /** A prepared Follow-up was stored for the Run (Issue #145): it is no longer preparing. */
  recordPreparationDone(): void {
    this.updateStatus(this.pullRequestStatus.preparationDone());
  }

  /**
   * A lookup of the pull request's state failed (Issue #142): the Run keeps its last known state
   * and gets `error`. With a retry (`retryAt`, a rate limit) it stays refreshing, from
   * `requestedAt`, until then.
   */
  recordRefreshFailed(error: string, retryAt: Date | null, requestedAt: Date): void {
    this.updateStatus(this.pullRequestStatus.refreshFailed(error, retryAt, requestedAt));
  }

  /** The reading of the failing checks' logs failed (Issue #145); as {@link recordRefreshFailed}. */
  recordPreparationFailed(error: string, retryAt: Date | null, requestedAt: Date): void {
    this.updateStatus(this.pullRequestStatus.preparationFailed(error, retryAt, requestedAt));
  }

  /**
   * The state of the pull request a worker read on its own, right before it refused a Follow-up
   * (review S4 of #152), as {@link RunPullRequestStatus.observed} says. A Run without a pull
   * request is left alone.
   */
  recordObservedPullRequestState(state: PullRequestState, now: Date): void {
    if (!this.delivery.hasPullRequest) return;
    this.updateStatus(this.pullRequestStatus.observed(state, now));
  }

  /**
   * Whether the agent worker may report this Run's diffs (Issue #144): it holds the Run, in
   * `preparing` or `running`, or `failed` and held for a delivery retry (Issue #102). Throws
   * {@link RunNotHeldError} otherwise.
   */
  assertDiffReportableBy(workerId: string): void {
    const held =
      isClaimedRunState(this.lifecycle.state) ||
      (this.lifecycle.state === 'failed' && this.delivery.requested);
    if (!held || !this.claim.isHeldBy(workerId)) throw new RunNotHeldError();
  }

  private updateStatus(next: RunPullRequestStatus): void {
    this.apply({ pullRequestStatus: next.toStored() });
  }

  private updateFollowUpEntry(details: BringUpDetails): void {
    Object.assign(this, { conversation: this.conversation.withFollowUpDetails(details) });
    const pending = CHANGES.get(this)!;
    pending.followUpEntry = { ...pending.followUpEntry, ...details };
  }

  /**
   * Applies a patch of stored fields to the value objects they belong to, and records it as what
   * the store saves: only the fields an operation changed are written.
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
