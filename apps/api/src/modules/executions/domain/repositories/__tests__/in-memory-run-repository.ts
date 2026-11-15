import { randomUUID } from 'node:crypto';
import {
  ACTIVE_RUN_STATES,
  CLAIMED_RUN_STATES,
  isFinal,
  MAX_ACTIVE_RUNS,
  type Run,
  type RunCancellation,
  type RunDeliveryOutcome,
  type RunFailure,
  type RunState,
  type RunWorkingCopy,
  stepLimitFailure,
} from '../../entities/run.js';
import type {
  AppendStepOutcome,
  ClaimedRunChange,
  DeliveryRetryOutcome,
  NewRun,
  RunRepository,
  RunStateView,
  RunStepRecord,
  StoredRunStep,
} from '../run-repository.js';

const isActive = (state: RunState) => (ACTIVE_RUN_STATES as readonly RunState[]).includes(state);
const isClaimed = (state: RunState) => (CLAIMED_RUN_STATES as readonly RunState[]).includes(state);
/** Active for the limits: an active state, or a failed Run held for a delivery retry (#102). */
const holdsPlace = (run: Run) => isActive(run.state) || run.claimedBy !== null;
const deliveryFields = (delivery: RunDeliveryOutcome) => ({
  delivery: delivery.outcome,
  pullRequest: delivery.outcome === 'delivered' ? { ...delivery.pullRequest } : null,
});

/**
 * In-memory adapter of {@link RunRepository} for handler tests, with the database adapter's
 * rules: claims honour the concurrency limits in creation order, worker changes are
 * conditional on state and holder, steps are stored only for a held `running` Run.
 */
export class InMemoryRunRepository implements RunRepository {
  readonly runs: (Run & {
    heartbeatAt: Date | null;
    lastClaimedBy?: string;
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
      environmentFileSupplied: false,
      environmentFilePath: null,
      environmentFileSecret: null,
    };
    this.runs.push(created);
    return Promise.resolve(this.view(created));
  }

  findById(id: string): Promise<Run | null> {
    const run = this.runs.find((candidate) => candidate.id === id);
    return Promise.resolve(run ? this.view(run) : null);
  }

  listNewestFirst(): Promise<Run[]> {
    return Promise.resolve([...this.runs].reverse().map((run) => this.view(run)));
  }

  listByProjectNewestFirst(projectId: string): Promise<Run[]> {
    return Promise.resolve(
      [...this.runs]
        .reverse()
        .filter((run) => run.projectId === projectId)
        .map((run) => this.view(run)),
    );
  }

  claimNext(workerId: string, now: Date): Promise<Run | null> {
    const active = this.runs.filter(holdsPlace);
    if (active.length >= MAX_ACTIVE_RUNS) return Promise.resolve(null);
    const busy = new Set(active.map((run) => run.projectId));
    const next = this.runs.find(
      (run) =>
        (run.state === 'queued' ||
          (run.state === 'failed' &&
            run.deliveryRequested &&
            run.claimedBy === null &&
            run.lastClaimedBy === workerId)) &&
        !busy.has(run.projectId),
    );
    if (!next) return Promise.resolve(null);
    if (next.state === 'queued') {
      Object.assign(next, {
        state: 'preparing',
        claimedBy: workerId,
        lastClaimedBy: workerId,
        startedAt: now,
        heartbeatAt: now,
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
        : { failure: { ...result.failure }, delivery: 'failed' }),
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
      this.runs.filter((run) => run.state === 'waiting_for_operator').map((run) => this.view(run)),
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
    if (index > run.limits.maxSteps) {
      Object.assign(run, {
        state: 'failed',
        failure: stepLimitFailure(run.limits.maxSteps),
        claimedBy: null,
        heartbeatAt: null,
        finishedAt: now,
      });
      return Promise.resolve({ status: 'step_limit' });
    }
    const { kind, result } = step;
    this.steps.push({ runId, index, step: structuredClone({ kind, result }) });
    run.workingCopy = structuredClone(workingCopy);
    run.failingChecks = [...failingChecks];
    run.stepStartedAt = null;
    return Promise.resolve({ status: 'stored', index });
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
      run.failure?.code === 'delivery_failed' &&
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

  private view(
    run: Run & {
      heartbeatAt: Date | null;
      lastClaimedBy?: string;
      environmentFileSecret: string | null;
    },
  ): Run {
    const { heartbeatAt, lastClaimedBy, environmentFileSecret, ...rest } = run;
    // Internal: not part of a Run.
    void heartbeatAt;
    void lastClaimedBy;
    void environmentFileSecret;
    return structuredClone(rest);
  }
}
