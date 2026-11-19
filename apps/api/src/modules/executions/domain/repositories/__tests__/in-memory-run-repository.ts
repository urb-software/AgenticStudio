import { randomUUID } from 'node:crypto';
import {
  CLAIMED_RUN_STATES,
  type RunState,
  UNDER_WAY_RUN_STATES,
} from '../../value-objects/run-state.js';
import {
  DeliveryNotRetryableError,
  FollowUpNotAllowedError,
  IllegalRunTransitionError,
  RunAlreadyFinishedError,
  RunNotHeldError,
  RunNotWaitingError,
  StepOutOfOrderError,
} from '../../errors/run-errors.js';
import { type FollowUpOrigin } from '../../entities/run-follow-up-facts.js';
import { type ResumeFacts } from '../../entities/run-resume-facts.js';
import { type RunStepRecord } from '../../entities/run-step-facts.js';
import { Run } from '../../entities/run.js';
import { RunPullRequestStatus } from '../../value-objects/run-pull-request-status.js';
import { isFinalRunState } from '../../value-objects/run-state.js';
import { type RunCancellation } from '../../value-objects/run-cancellation.js';
import { type RunMessage } from '../../value-objects/run-message.js';
import { type RestoreData } from '../../../../../__tests__/restore-data.js';
import { type RunLimits } from '../../value-objects/run-limits.js';
import { type RunDeliveryOutcome } from '../../value-objects/run-delivery.js';
import { type RunFailure } from '../../value-objects/run-failure.js';
import { type Provider } from '../../value-objects/provider.js';
import { type RunWorkingCopy } from '../../value-objects/run-working-copy.js';
import { HandOutRule } from '../../value-objects/hand-out-rule.js';
import { Task } from '../../value-objects/task.js';
import type { PreparedFollowUp } from '../../entities/prepared-follow-up.js';
import type { ReviewComments } from '../../entities/review-comments.js';
import type {
  LimitedRunView,
  RunRepository,
  RunsSummary,
  RunStateView,
} from '../run-repository.js';

type StoredRun = Omit<RestoreData<typeof Run>, 'messages'> & {
  messages: RunMessage[];
  environmentFileSecret: string | null;
};

export interface StartedRun {
  id?: string;
  projectId: string;
  provider: Provider;
  task: string;
  startCommit: string;
  remoteUrl: string;
  limits: RunLimits;
  integrationBranch: string;
}

export interface ClaimedRunChange {
  runId: string;
  workerId: string;
  from: RunState;
  to: RunState;
  failure: RunFailure | null;
  workingCopy?: RunWorkingCopy | null;
  delivery?: RunDeliveryOutcome | null;
  sessionRef?: string | null;
  pushedCommit?: string | null;
  cancelRequested: boolean;
  now: Date;
}

export type AppendStepOutcome =
  | { status: 'stored'; index: number; duplicate?: boolean }
  | { status: 'out_of_order'; expected: number }
  | { status: 'not_held' }
  | { status: 'step_limit' };

const isClaimed = (state: RunState) => (CLAIMED_RUN_STATES as readonly RunState[]).includes(state);
const queuedToResume = (run: RestoreData<typeof Run>) =>
  run.state === 'queued' && run.sessionRef !== null;

/** In-memory {@link RunRepository} for handler tests, following the database adapter's rules. */
export class InMemoryRunRepository implements RunRepository {
  readonly runs: StoredRun[] = [];
  readonly steps: { runId: string; index: number; step: RunStepRecord }[] = [];
  private sequence = 0;

  add(run: Run): Promise<Run> {
    const created = {
      id: run.id,
      projectId: run.projectId,
      provider: run.provider,
      task: run.task,
      startCommit: run.startCommit,
      remoteUrl: run.remoteUrl,
      integrationBranch: run.delivery.integrationBranch,
      state: 'queued' as const,
      createdAt: new Date(Date.UTC(2026, 10, 15, 10, 0, this.sequence++)),
      startedAt: null,
      finishedAt: null,
      failure: null,
      claimedBy: null,
      heartbeatAt: null,
      workingCopy: null,
      limits: { ...run.progress.limits },
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
      pullRequestStatus: RunPullRequestStatus.none().toData(),
      lastActivityAt: new Date(Date.UTC(2026, 10, 15, 10, 0, this.sequence - 1)),
    };
    this.runs.push(created);
    return Promise.resolve(this.view(created));
  }

  findById(id: string): Promise<Run | null> {
    const run = this.runs.find((candidate) => candidate.id === id);
    return Promise.resolve(run ? this.view(run) : null);
  }

  exists(id: string): Promise<boolean> {
    return Promise.resolve(this.runs.some((candidate) => candidate.id === id));
  }

  save(run: Run): Promise<void> {
    const stored = this.runs.find((candidate) => candidate.id === run.id);
    if (stored) this.apply(stored, run);
    return Promise.resolve();
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
    const next = HandOutRule.for(workerId).next(this.runs);
    if (!next) return Promise.resolve(null);
    if (next.state === 'queued') {
      Object.assign(next, {
        state: 'preparing',
        claimedBy: workerId,
        lastClaimedBy: workerId,
        // A resumed Run keeps its first start.
        startedAt: next.startedAt ?? now,
        heartbeatAt: now,
        followUpQueued: false,
      });
    } else {
      Object.assign(next, { claimedBy: workerId, heartbeatAt: now });
    }
    return Promise.resolve(this.view(next));
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

  listWaiting(): Promise<Run[]> {
    return Promise.resolve(
      this.runs
        .filter((run) => run.state === 'waiting_for_operator')
        .map((run) => this.listed(run)),
    );
  }

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
        .map((run) => ({
          runId: run.id,
          projectId: run.projectId,
          provider: run.provider,
          sessionRef: run.sessionRef,
          state: run.state,
          finishedAt: run.finishedAt,
          hasPullRequest: run.pullRequest !== null,
          pullRequestState: run.pullRequestStatus.state,
          pullRequestEndedAt: run.pullRequestStatus.endedAt,
          lastActivityAt: run.lastActivityAt,
        })),
    );
  }

  findLimitedRuns(projectIds: readonly string[]): Promise<LimitedRunView[]> {
    return Promise.resolve(
      this.runs.flatMap((run) =>
        projectIds.includes(run.projectId) &&
        isFinalRunState(run.state) &&
        run.finishedAt !== null &&
        run.pullRequest === null &&
        run.workingCopy !== null &&
        run.workingCopyRemovedAt === null
          ? [{ runId: run.id, projectId: run.projectId, finishedAt: run.finishedAt }]
          : [],
      ),
    );
  }

  readonly prepared = new Map<string, PreparedFollowUp>();

  readonly reviewSets = new Map<string, ReviewComments>();

  async change(runId: string, mutate: (run: Run) => void): Promise<Run | null> {
    return this.changeStored(runId, (run) => mutate(run));
  }

  async changeSerializedWithClaims(
    runId: string,
    mutate: (run: Run, facts: ResumeFacts) => void,
  ): Promise<Run | null> {
    return this.changeStored(runId, (run, stored) => {
      const others = this.runs.filter(
        (other) => other.id !== runId && HandOutRule.countingPlaces().holdsPlace(other),
      );
      mutate(run, {
        projectPlaceTaken: others.some((other) => other.projectId === stored.projectId),
        serverPlacesTaken: others.length,
        environmentFileSnapshotKept: stored.environmentFileSecret !== null,
      });
    });
  }

  /** Keeps what `work` changed only when it did not throw, like the database transaction. */
  private changeStored(runId: string, work: (run: Run, stored: StoredRun) => void): Run | null {
    const stored = this.runs.find((candidate) => candidate.id === runId);
    if (!stored) return null;
    const run = this.view(stored);
    work(run, stored);
    this.apply(stored, run);
    return this.view(stored);
  }

  private apply(stored: StoredRun, run: Run): void {
    const runId = stored.id;
    const changes = run.pendingChanges();
    Object.assign(stored, structuredClone(changes.fields));
    const entry = stored.messages.findLast((message) => message.kind === 'follow_up');
    if (changes.followUpEntry && entry?.kind === 'follow_up') {
      Object.assign(entry, structuredClone(changes.followUpEntry));
    }
    for (const step of changes.steps ?? []) {
      const { kind, result } = step;
      this.steps.push({ runId, index: step.index, step: structuredClone({ kind, result }) });
    }
    if (changes.environmentFileSecretRef !== undefined) {
      stored.environmentFileSecret = changes.environmentFileSecretRef;
    }
    stored.messages.push(...structuredClone(changes.messages));
  }

  start(input: StartedRun): Promise<Run> {
    return this.add(
      Run.start({
        ...input,
        id: input.id ?? randomUUID(),
        task: Task.of(input.task),
        // Distinct, increasing creation times, like the database's clock.
        now: new Date(Date.UTC(2026, 10, 15, 10, 0, this.sequence)),
      }),
    );
  }

  // Test setup shortcuts, not part of the Run repository: they return `null`
  // (or `false`) when refused.

  /** The operator answers the open question; `null` if the Run is not waiting with one. */
  async answer(runId: string, text: string, now: Date): Promise<Run | null> {
    return this.refusedAsNull(
      () => this.change(runId, (run) => run.answer(text, now)),
      [RunNotWaitingError],
    );
  }

  /** The operator cancels (a request, or at once for a Run no worker holds); `null` if finished. */
  async cancel(runId: string, now: Date): Promise<Run | null> {
    return this.refusedAsNull(
      () => this.change(runId, (run) => run.cancel(now)),
      [RunAlreadyFinishedError],
    );
  }

  /** The operator requests a delivery retry; `null` if the delivery did not fail. */
  async requestDeliveryRetry(runId: string): Promise<Run | null> {
    return this.refusedAsNull(
      () => this.change(runId, (run) => run.requestDeliveryRetry()),
      [DeliveryNotRetryableError],
    );
  }

  /** The operator sends a Follow-up with the agent worker and Provider available. */
  async queueFollowUp(
    runId: string,
    text: string,
    now: Date,
    origin?: FollowUpOrigin,
  ): Promise<Run | null> {
    const available = { workerAvailable: true, providerAvailable: true };
    return this.refusedAsNull(
      () => this.change(runId, (run) => void run.followUp(text, now, available, origin)),
      [FollowUpNotAllowedError],
    );
  }

  /** Only while the Run is still as `from` and the cancel request state; `null` if refused. */
  async transitionClaimed(change: ClaimedRunChange): Promise<Run | null> {
    return this.refusedAsNull(
      () =>
        this.change(change.runId, (run) => {
          if (
            run.lifecycle.state !== change.from ||
            (run.lifecycle.cancelRequestedAt !== null) !== change.cancelRequested
          ) {
            throw new RunNotHeldError();
          }
          run.reportState(
            change.workerId,
            {
              state: change.to,
              failure: change.failure,
              workingCopy: change.workingCopy ?? null,
              delivery: change.delivery ?? null,
              sessionRef: change.sessionRef ?? null,
              pushedCommit: change.pushedCommit ?? null,
            },
            change.now,
          );
        }),
      [RunNotHeldError, IllegalRunTransitionError],
    );
  }

  /** The agent worker reports a Run step. */
  async appendStep(
    runId: string,
    workerId: string,
    step: RunStepRecord,
    workingCopy: RunWorkingCopy,
    failingChecks: readonly string[],
    now: Date,
  ): Promise<AppendStepOutcome> {
    let outcome: AppendStepOutcome = { status: 'not_held' };
    try {
      await this.change(runId, (run) => {
        outcome = run.reportStep(workerId, step, workingCopy, failingChecks, now);
      });
    } catch (error) {
      if (error instanceof RunNotHeldError) return { status: 'not_held' };
      if (error instanceof StepOutOfOrderError) {
        return { status: 'out_of_order', expected: error.expected };
      }
      throw error;
    }
    return outcome;
  }

  /** The agent worker's heartbeat; `null` if it does not hold the Run. */
  async heartbeat(
    runId: string,
    workerId: string,
    now: Date,
  ): Promise<{ cancelRequested: boolean } | null> {
    let answer: { cancelRequested: boolean } | null = null;
    try {
      await this.change(runId, (run) => {
        answer = run.recordHeartbeat(workerId, now);
      });
    } catch (error) {
      if (error instanceof RunNotHeldError) return null;
      throw error;
    }
    return answer;
  }

  /** The agent worker reports where a bring-up-to-date merge started; `false` if not recorded. */
  async recordUpdateStart(
    runId: string,
    workerId: string,
    start: { baseCommit: string; integrationCommit: string },
  ): Promise<boolean> {
    let recorded = false;
    await this.change(runId, (run) => {
      recorded = run.recordUpdateStart(workerId, start);
    });
    return recorded;
  }

  /** A bring-up-to-date part succeeded; `false` if there was nothing to record. */
  async recordMergedCommit(runId: string): Promise<boolean> {
    let recorded = false;
    await this.change(runId, (run) => {
      recorded = run.recordMergedCommit();
    });
    return recorded;
  }

  /**
   * The agent worker reports a bring-up-to-date request that changed nothing; `null` if refused.
   */
  async finishBringUpToDate(
    runId: string,
    workerId: string,
    detail: string,
    now: Date,
  ): Promise<Run | null> {
    return this.refusedAsNull(
      () =>
        this.change(runId, (run) => {
          run.reportState(
            workerId,
            { state: 'succeeded', failure: null, unchanged: true, unchangedDetail: detail },
            now,
          );
        }),
      [RunNotHeldError, IllegalRunTransitionError],
    );
  }

  /** The agent worker reports the removal of Working copies; how many were recorded. */
  async markWorkingCopiesRemoved(
    workerId: string,
    runIds: readonly string[],
    now: Date,
  ): Promise<number> {
    let recorded = 0;
    for (const runId of runIds) {
      await this.change(runId, (run) => {
        if (run.reportWorkingCopyRemoved(workerId, now)) recorded++;
      });
    }
    return recorded;
  }

  /**
   * The claim gives the `preparing` Run its Environment file; `false` if it is no longer so held.
   */
  async attachEnvironmentFile(
    runId: string,
    workerId: string,
    file: { path: string; secretRef: string },
  ): Promise<boolean> {
    return this.replaceEnvironmentFile(runId, workerId, file);
  }

  /**
   * The claim replaces the `preparing` Run's Environment file; `false` if it is no longer so held.
   */
  async replaceEnvironmentFile(
    runId: string,
    workerId: string,
    file: { path: string; secretRef: string } | null,
  ): Promise<boolean> {
    try {
      return (
        (await this.change(runId, (run) => run.recordEnvironmentFile(workerId, file))) !== null
      );
    } catch (error) {
      if (error instanceof RunNotHeldError) return false;
      throw error;
    }
  }

  private async refusedAsNull(
    operation: () => Promise<Run | null>,
    refusals: (abstract new (...args: never[]) => Error)[],
  ): Promise<Run | null> {
    try {
      return await operation();
    } catch (error) {
      if (refusals.some((refusal) => error instanceof refusal)) return null;
      throw error;
    }
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

  listSteps(runId: string): ReturnType<RunRepository['listSteps']> {
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

  findEnvironmentFileSecret(runId: string): Promise<string | null> {
    return Promise.resolve(
      this.runs.find((candidate) => candidate.id === runId)?.environmentFileSecret ?? null,
    );
  }

  listReleasableEnvironmentFileSecrets(
    retryableFinishedBefore: Date,
  ): Promise<{ runId: string; secretRef: string }[]> {
    const retryable = (run: RestoreData<typeof Run>) =>
      run.state === 'failed' &&
      (run.failure?.code === 'delivery_failed' || run.failure?.code === 'usage_limit') &&
      (run.deliveryRequested ||
        (run.finishedAt !== null && run.finishedAt >= retryableFinishedBefore));
    return Promise.resolve(
      this.runs
        .filter((run) => isFinalRunState(run.state) && run.environmentFileSecret !== null)
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

  listDueForDailyRefresh(attemptedBefore: Date, limit: number): Promise<string[]> {
    return Promise.resolve(
      this.runs
        .filter((run) => {
          const status = run.pullRequestStatus;
          const attempt = status.lastAttemptAt ?? status.refreshedAt;
          return (
            run.pullRequest !== null &&
            run.workingCopy !== null &&
            status.refreshRequestedAt === null &&
            (status.state === null || status.state === 'draft' || status.state === 'open') &&
            (attempt === null || attempt < attemptedBefore)
          );
        })
        .slice(0, limit)
        .map((run) => run.id),
    );
  }

  /** Without its conversation, like the database adapter's lists. */
  private listed(run: StoredRun): Run {
    return Run.restore({ ...this.data(run), messages: [] });
  }

  private view(run: StoredRun): Run {
    return Run.restore(this.data(run));
  }

  private data(run: StoredRun): RestoreData<typeof Run> {
    const { environmentFileSecret, ...rest } = run;
    void environmentFileSecret;
    return structuredClone(rest);
  }
}
