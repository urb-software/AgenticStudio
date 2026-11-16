import { randomUUID } from 'node:crypto';
import {
  ACTIVE_RUN_STATES,
  canResumeAfterUsageLimit,
  CLAIMED_RUN_STATES,
  type FollowUpSource,
  isFinal,
  partEndOf,
  MAX_ACTIVE_RUNS,
  NO_PULL_REQUEST_STATUS,
  type Run,
  type RunCancellation,
  type RunDeliveryOutcome,
  type RunFailure,
  type RunState,
  type RunWorkingCopy,
  stepLimitFailure,
  UNDER_WAY_RUN_STATES,
} from '../../entities/run.js';
import type { PreparedFollowUp } from '../../entities/prepared-follow-up.js';
import type {
  AppendStepOutcome,
  ClaimedRunChange,
  DeliveryRetryOutcome,
  NewRun,
  ResumeAfterLimitOutcome,
  RunRepository,
  RunsSummary,
  RunStateView,
  RunStepRecord,
  StoredRunStep,
} from '../run-repository.js';

const isActive = (state: RunState) => (ACTIVE_RUN_STATES as readonly RunState[]).includes(state);
const isClaimed = (state: RunState) => (CLAIMED_RUN_STATES as readonly RunState[]).includes(state);
/** Queued with a session reference: the database adapter's test for a Run queued to resume. */
const queuedToResume = (run: Run) => run.state === 'queued' && run.sessionRef !== null;

/**
 * Active for the limits: an active state, a failed Run held for a delivery retry (#102), or a
 * resumable Run waiting for its worker (#103); a queued Follow-up holds none (#141).
 */
const holdsPlace = (run: Run) =>
  isActive(run.state) || run.claimedBy !== null || (queuedToResume(run) && !run.followUpQueued);
const deliveryFields = (delivery: RunDeliveryOutcome) => ({
  delivery: delivery.outcome,
  ...(delivery.outcome === 'delivered' ? { pullRequest: { ...delivery.pullRequest } } : {}),
  ...(delivery.pushedCommit === undefined ? {} : { pushedCommit: delivery.pushedCommit }),
});

/**
 * In-memory adapter of {@link RunRepository} for handler tests, with the database adapter's
 * rules: claims honour the concurrency limits in creation order, worker changes are
 * conditional on state and holder, steps are stored only for a held `running` Run.
 */
export class InMemoryRunRepository implements RunRepository {
  readonly runs: (Run & {
    heartbeatAt: Date | null;
    environmentFileSecret: string | null;
  })[] = [];
  readonly steps: { runId: string; index: number; step: RunStepRecord }[] = [];
  private sequence = 0;

  add(run: NewRun): Promise<Run> {
    const created = {
      ...run,
      id: randomUUID(),
      state: 'queued' as const,
      // Distinct, increasing creation times, like the database's clock.
      createdAt: new Date(Date.UTC(2026, 10, 15, 10, 0, this.sequence++)),
      startedAt: null,
      finishedAt: null,
      failure: null,
      claimedBy: null,
      heartbeatAt: null,
      workingCopy: null,
      limits: { ...run.limits },
      cancelRequestedAt: null,
      cancellation: null,
      waitingSince: null,
      stepStartedAt: null,
      releasedBy: null,
      delivery: null,
      pullRequest: null,
      deliveryRequested: false,
      failingChecks: [],
      sessionRef: null,
      messages: [],
      environmentFileSupplied: false,
      environmentFilePath: null,
      environmentFileSecret: null,
      lastClaimedBy: null,
      stepCount: 0,
      followUpCount: 0,
      followUpQueued: false,
      stepsBeforePart: 0,
      pushedCommit: null,
      workingCopyRemovedAt: null,
      pullRequestStatus: NO_PULL_REQUEST_STATUS,
    };
    this.runs.push(created);
    return Promise.resolve(this.view(created));
  }

  findById(id: string): Promise<Run | null> {
    const run = this.runs.find((candidate) => candidate.id === id);
    return Promise.resolve(run ? this.view(run) : null);
  }

  listNewestFirst(): Promise<Run[]> {
    return Promise.resolve([...this.runs].reverse().map((run) => this.listed(run)));
  }

  summarize(): Promise<RunsSummary> {
    const count = (states: readonly RunState[]) =>
      this.runs.filter((run) => states.includes(run.state)).length;
    return Promise.resolve({
      running: count(UNDER_WAY_RUN_STATES),
      waiting: count(['waiting_for_operator']),
    });
  }

  listByProjectNewestFirst(projectId: string): Promise<Run[]> {
    return Promise.resolve(
      [...this.runs]
        .reverse()
        .filter((run) => run.projectId === projectId)
        .map((run) => this.listed(run)),
    );
  }

  claimNext(workerId: string, now: Date): Promise<Run | null> {
    // A candidate's own place does not count against it (a resumable Run keeps one, #103).
    const others = (candidate: Run) =>
      this.runs.filter((run) => run.id !== candidate.id && holdsPlace(run));
    const next = this.runs.find(
      (run) =>
        ((run.state === 'queued' && (!queuedToResume(run) || run.lastClaimedBy === workerId)) ||
          (run.state === 'failed' &&
            run.deliveryRequested &&
            run.claimedBy === null &&
            run.lastClaimedBy === workerId)) &&
        others(run).length < MAX_ACTIVE_RUNS &&
        !others(run).some((other) => other.projectId === run.projectId),
    );
    if (!next) return Promise.resolve(null);
    if (next.state === 'queued') {
      Object.assign(next, {
        state: 'preparing',
        claimedBy: workerId,
        lastClaimedBy: workerId,
        // A resumed Run keeps its first start (#103).
        startedAt: next.startedAt ?? now,
        heartbeatAt: now,
        followUpQueued: false,
      });
    } else {
      Object.assign(next, { claimedBy: workerId, heartbeatAt: now });
    }
    return Promise.resolve(this.view(next));
  }

  transitionClaimed(change: ClaimedRunChange): Promise<Run | null> {
    const run = this.runs.find((candidate) => candidate.id === change.runId);
    if (
      !run ||
      run.state !== change.from ||
      run.claimedBy !== change.workerId ||
      (run.cancelRequestedAt !== null) !== change.cancelRequested
    ) {
      return Promise.resolve(null);
    }
    const held = isClaimed(change.to);
    Object.assign(run, {
      state: change.to,
      failure: change.failure,
      claimedBy: held ? change.workerId : null,
      heartbeatAt: held ? change.now : null,
      finishedAt: isFinal(change.to) ? change.now : null,
      cancellation: change.to === 'cancelled' ? (change.cancellation ?? null) : null,
      waitingSince: change.to === 'waiting_for_operator' ? change.now : null,
      stepStartedAt: change.to === 'running' ? change.now : run.stepStartedAt,
      releasedBy: held ? null : change.workerId,
      ...(change.workingCopy ? { workingCopy: structuredClone(change.workingCopy) } : {}),
      ...((change.to === 'succeeded' || change.to === 'cancelled') && change.delivery
        ? deliveryFields(change.delivery)
        : {}),
      ...(change.failure?.code === 'delivery_failed' ? { delivery: 'failed' } : {}),
      ...(change.pushedCommit ? { pushedCommit: change.pushedCommit } : {}),
      ...(change.to === 'failed' && change.failure?.code === 'usage_limit' && change.sessionRef
        ? { sessionRef: change.sessionRef }
        : {}),
    });
    return Promise.resolve(this.view(run));
  }

  requestDeliveryRetry(runId: string): Promise<Run | null> {
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (!run || run.state !== 'failed' || run.failure?.code !== 'delivery_failed') {
      return Promise.resolve(null);
    }
    run.deliveryRequested = true;
    return Promise.resolve(this.view(run));
  }

  listPendingDeliveryRetries(): Promise<{ runId: string; startedBy: string | null }[]> {
    return Promise.resolve(
      this.runs
        .filter((run) => run.state === 'failed' && run.deliveryRequested && run.claimedBy === null)
        .map((run) => ({ runId: run.id, startedBy: run.lastClaimedBy ?? null })),
    );
  }

  abandonDeliveryRetry(runId: string, failure: RunFailure, now: Date): Promise<boolean> {
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (!run || run.state !== 'failed' || !run.deliveryRequested || run.claimedBy !== null) {
      return Promise.resolve(false);
    }
    Object.assign(run, {
      failure: { ...failure },
      delivery: 'failed',
      deliveryRequested: false,
      finishedAt: now,
    });
    return Promise.resolve(true);
  }

  finishDeliveryRetry(outcome: DeliveryRetryOutcome): Promise<Run | null> {
    const run = this.runs.find((candidate) => candidate.id === outcome.runId);
    if (
      !run ||
      run.state !== 'failed' ||
      !run.deliveryRequested ||
      run.claimedBy !== outcome.workerId
    ) {
      return Promise.resolve(null);
    }
    const { result } = outcome;
    Object.assign(run, {
      claimedBy: null,
      releasedBy: outcome.workerId,
      heartbeatAt: null,
      deliveryRequested: false,
      finishedAt: outcome.now,
      ...(outcome.workingCopy ? { workingCopy: structuredClone(outcome.workingCopy) } : {}),
      ...(result.state === 'succeeded'
        ? { state: 'succeeded', failure: null, ...deliveryFields(result.delivery) }
        : {
            failure: { ...result.failure },
            delivery: 'failed',
            ...(outcome.pushedCommit ? { pushedCommit: outcome.pushedCommit } : {}),
          }),
    });
    return Promise.resolve(this.view(run));
  }

  heartbeat(
    runId: string,
    workerId: string,
    now: Date,
  ): Promise<{ cancelRequested: boolean } | null> {
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (!run || run.claimedBy !== workerId || !isClaimed(run.state)) return Promise.resolve(null);
    run.heartbeatAt = now;
    return Promise.resolve({ cancelRequested: run.cancelRequestedAt !== null });
  }

  cancelUnheld(
    runId: string,
    from: 'queued' | 'waiting_for_operator',
    cancellation: RunCancellation,
    now: Date,
  ): Promise<Run | null> {
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (!run || run.state !== from) return Promise.resolve(null);
    Object.assign(run, {
      state: 'cancelled',
      cancellation: { ...cancellation },
      finishedAt: now,
      waitingSince: null,
      followUpQueued: false,
    });
    return Promise.resolve(this.view(run));
  }

  requestCancel(runId: string, now: Date): Promise<Run | null> {
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (!run || !isClaimed(run.state)) return Promise.resolve(null);
    run.cancelRequestedAt ??= now;
    return Promise.resolve(this.view(run));
  }

  listWaiting(): Promise<Run[]> {
    return Promise.resolve(
      this.runs
        .filter((run) => run.state === 'waiting_for_operator')
        .map((run) => this.listed(run)),
    );
  }

  /** The last lease renewal at API start (the database adapter stores it in a table). */
  lastRenewal: Date | null = null;

  renewClaimsOncePerLease(now: Date, leaseSeconds: number): Promise<number | null> {
    if (this.lastRenewal && now.getTime() - this.lastRenewal.getTime() < leaseSeconds * 1000) {
      return Promise.resolve(null);
    }
    this.lastRenewal = now;
    const held = this.runs.filter((run) => isClaimed(run.state));
    for (const run of held) run.heartbeatAt = now;
    return Promise.resolve(held.length);
  }

  timeOutOverdueSteps(now: Date, graceMinutes: number): Promise<number> {
    const overdue = this.runs.filter(
      (run) =>
        run.state === 'running' &&
        run.stepStartedAt !== null &&
        now.getTime() - run.stepStartedAt.getTime() >
          (run.limits.stepMinutes + graceMinutes) * 60_000,
    );
    for (const run of overdue) {
      Object.assign(run, {
        state: 'timed_out',
        claimedBy: null,
        heartbeatAt: null,
        finishedAt: now,
      });
    }
    return Promise.resolve(overdue.length);
  }

  findStates(ids: readonly string[]): Promise<RunStateView[]> {
    return Promise.resolve(
      this.runs
        .filter((run) => ids.includes(run.id))
        .map((run) => ({ runId: run.id, state: run.state, finishedAt: run.finishedAt })),
    );
  }

  appendStep(
    runId: string,
    workerId: string,
    step: RunStepRecord,
    workingCopy: RunWorkingCopy,
    failingChecks: readonly string[],
    now: Date,
  ): Promise<AppendStepOutcome> {
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (!run || run.state !== 'running' || run.claimedBy !== workerId) {
      return Promise.resolve({ status: 'not_held' });
    }
    const last = this.steps.filter((stored) => stored.runId === runId).length;
    const index = step.index ?? last + 1;
    if (index <= last) return Promise.resolve({ status: 'stored', index, duplicate: true });
    if (index !== last + 1) return Promise.resolve({ status: 'out_of_order', expected: last + 1 });
    if (index > run.stepsBeforePart + run.limits.maxSteps) {
      Object.assign(run, {
        state: 'failed',
        failure: stepLimitFailure(run.limits.maxSteps, run.followUpCount > 0),
        claimedBy: null,
        heartbeatAt: null,
        finishedAt: now,
      });
      return Promise.resolve({ status: 'step_limit' });
    }
    const { kind, result } = step;
    this.steps.push({ runId, index, step: structuredClone({ kind, result }) });
    run.stepCount = index;
    run.workingCopy = structuredClone(workingCopy);
    run.failingChecks = [...failingChecks];
    run.stepStartedAt = null;
    if (step.sessionRef !== undefined) run.sessionRef = step.sessionRef;
    if (step.question) {
      run.messages.push({ kind: 'question', question: structuredClone(step.question), at: now });
    }
    return Promise.resolve({ status: 'stored', index });
  }

  answer(runId: string, text: string, now: Date): Promise<Run | null> {
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (!run || run.state !== 'waiting_for_operator' || run.messages.at(-1)?.kind !== 'question') {
      return Promise.resolve(null);
    }
    run.messages.push({ kind: 'answer', text, at: now });
    Object.assign(run, { state: 'queued', waitingSince: null });
    return Promise.resolve(this.view(run));
  }

  resumeAfterUsageLimit(runId: string, text: string, now: Date): Promise<ResumeAfterLimitOutcome> {
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (
      !run ||
      !canResumeAfterUsageLimit(run) ||
      (run.environmentFileSupplied && run.environmentFileSecret === null && run.followUpCount === 0)
    ) {
      return Promise.resolve({ status: 'not_resumable' });
    }
    const others = this.runs.filter((other) => other.id !== run.id && holdsPlace(other));
    if (others.some((other) => other.projectId === run.projectId)) {
      return Promise.resolve({ status: 'slot_taken', scope: 'project' });
    }
    if (others.length >= MAX_ACTIVE_RUNS) {
      return Promise.resolve({ status: 'slot_taken', scope: 'server' });
    }
    run.messages.push({ kind: 'answer', text, at: now });
    Object.assign(run, { state: 'queued', failure: null, finishedAt: null });
    return Promise.resolve({ status: 'resumed', run: this.view(run) });
  }

  /** Issue #145: the prepared Follow-ups, by Run id (shared with the lookup and prepared stores). */
  readonly prepared = new Map<string, PreparedFollowUp>();

  queueFollowUp(
    runId: string,
    text: string,
    now: Date,
    source?: FollowUpSource,
  ): Promise<Run | null> {
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (
      !run ||
      !isFinal(run.state) ||
      run.claimedBy !== null ||
      run.deliveryRequested ||
      run.followUpQueued ||
      run.sessionRef === null ||
      run.workingCopy === null ||
      run.workingCopyRemovedAt !== null ||
      run.stepCount >= run.limits.maxTotalSteps
    ) {
      return Promise.resolve(null);
    }
    run.messages.push({ kind: 'part_end', ...partEndOf(run)!, at: now });
    run.messages.push({
      kind: 'follow_up',
      text,
      at: now,
      ...(source === undefined ? {} : { source }),
    });
    if (source !== undefined && this.prepared.get(runId)?.source === source) {
      this.prepared.delete(runId);
    }
    Object.assign(run, {
      state: 'queued',
      followUpQueued: true,
      followUpCount: run.followUpCount + 1,
      stepsBeforePart: run.stepCount,
      failure: null,
      finishedAt: null,
      cancellation: null,
      cancelRequestedAt: null,
      delivery: null,
      waitingSince: null,
      stepStartedAt: null,
    });
    return Promise.resolve(this.view(run));
  }

  markWorkingCopiesRemoved(
    workerId: string,
    runIds: readonly string[],
    now: Date,
  ): Promise<number> {
    const removed = this.runs.filter(
      (run) =>
        runIds.includes(run.id) &&
        run.lastClaimedBy === workerId &&
        run.claimedBy === null &&
        run.workingCopyRemovedAt === null,
    );
    for (const run of removed) run.workingCopyRemovedAt = now;
    return Promise.resolve(removed.length);
  }

  listPendingResumes(): Promise<{ runId: string; startedBy: string | null }[]> {
    return Promise.resolve(
      this.runs
        .filter((run) => queuedToResume(run))
        .map((run) => ({ runId: run.id, startedBy: run.lastClaimedBy ?? null })),
    );
  }

  abandonResume(runId: string, failure: RunFailure, now: Date): Promise<boolean> {
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (!run || !queuedToResume(run)) return Promise.resolve(false);
    Object.assign(run, {
      state: 'failed',
      failure: { ...failure },
      finishedAt: now,
      followUpQueued: false,
    });
    return Promise.resolve(true);
  }

  listSteps(runId: string): Promise<StoredRunStep[]> {
    return Promise.resolve(
      this.steps
        .filter((stored) => stored.runId === runId)
        .map((stored) => ({
          index: stored.index,
          ...structuredClone(stored.step),
          reportedAt: new Date(Date.UTC(2026, 10, 15, 11, 0, stored.index)),
        })),
    );
  }

  failStaleClaims(
    staleBefore: Date,
    failure: RunFailure,
    deliveryFailure: RunFailure,
    now: Date,
  ): Promise<number> {
    const stale = this.runs.filter(
      (run) => run.claimedBy !== null && run.heartbeatAt !== null && run.heartbeatAt < staleBefore,
    );
    for (const run of stale) {
      Object.assign(run, {
        claimedBy: null,
        heartbeatAt: null,
        finishedAt: now,
        ...(isClaimed(run.state)
          ? { state: 'failed', failure }
          : { failure: deliveryFailure, delivery: 'failed', deliveryRequested: false }),
      });
    }
    return Promise.resolve(stale.length);
  }

  attachEnvironmentFile(
    runId: string,
    workerId: string,
    file: { path: string; secretRef: string },
  ): Promise<boolean> {
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (!run || run.state !== 'preparing' || run.claimedBy !== workerId) {
      return Promise.resolve(false);
    }
    Object.assign(run, {
      environmentFileSupplied: true,
      environmentFilePath: file.path,
      environmentFileSecret: file.secretRef,
    });
    return Promise.resolve(true);
  }

  replaceEnvironmentFile(
    runId: string,
    workerId: string,
    file: { path: string; secretRef: string } | null,
  ): Promise<boolean> {
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (!run || run.state !== 'preparing' || run.claimedBy !== workerId) {
      return Promise.resolve(false);
    }
    Object.assign(run, {
      environmentFileSupplied: file !== null,
      environmentFilePath: file?.path ?? null,
      environmentFileSecret: file?.secretRef ?? null,
    });
    return Promise.resolve(true);
  }

  findEnvironmentFileSecret(runId: string): Promise<string | null> {
    return Promise.resolve(
      this.runs.find((candidate) => candidate.id === runId)?.environmentFileSecret ?? null,
    );
  }

  listReleasableEnvironmentFileSecrets(
    retryableFinishedBefore: Date,
  ): Promise<{ runId: string; secretRef: string }[]> {
    const retryable = (run: Run) =>
      run.state === 'failed' &&
      (run.failure?.code === 'delivery_failed' || run.failure?.code === 'usage_limit') &&
      (run.deliveryRequested ||
        (run.finishedAt !== null && run.finishedAt >= retryableFinishedBefore));
    return Promise.resolve(
      this.runs
        .filter((run) => isFinal(run.state) && run.environmentFileSecret !== null)
        .filter((run) => !retryable(run))
        .map((run) => ({ runId: run.id, secretRef: run.environmentFileSecret! })),
    );
  }

  clearEnvironmentFileSecret(runId: string, secretRef: string): Promise<void> {
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (run?.environmentFileSecret === secretRef) run.environmentFileSecret = null;
    return Promise.resolve();
  }

  listEnvironmentFileSecretRefs(): Promise<string[]> {
    return Promise.resolve(
      this.runs.flatMap((run) => (run.environmentFileSecret ? [run.environmentFileSecret] : [])),
    );
  }

  /** A Run as lists read it: without its conversation (Issue #103), like the database adapter. */
  private listed(run: Parameters<InMemoryRunRepository['view']>[0]): Run {
    return { ...this.view(run), messages: [] };
  }

  private view(
    run: Run & {
      heartbeatAt: Date | null;
      environmentFileSecret: string | null;
    },
  ): Run {
    const { heartbeatAt, environmentFileSecret, ...rest } = run;
    // Internal: not part of a Run.
    void heartbeatAt;
    void environmentFileSecret;
    return structuredClone(rest);
  }
}
