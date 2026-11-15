import { randomUUID } from 'node:crypto';
import {
  ACTIVE_RUN_STATES,
  CLAIMED_RUN_STATES,
  isFinal,
  MAX_ACTIVE_RUNS,
  type Run,
  type RunCancellation,
  type RunFailure,
  type RunState,
  type RunWorkingCopy,
  stepLimitFailure,
} from '../../entities/run.js';
import type {
  AppendStepOutcome,
  ClaimedRunChange,
  NewRun,
  RunRepository,
  RunStateView,
  RunStepRecord,
  StoredRunStep,
} from '../run-repository.js';

const isActive = (state: RunState) => (ACTIVE_RUN_STATES as readonly RunState[]).includes(state);
const isClaimed = (state: RunState) => (CLAIMED_RUN_STATES as readonly RunState[]).includes(state);

/**
 * In-memory adapter of {@link RunRepository} for handler tests, with the database adapter's
 * rules: claims honour the concurrency limits in creation order, worker changes are
 * conditional on state and holder, steps are stored only for a held `running` Run.
 */
export class InMemoryRunRepository implements RunRepository {
  readonly runs: (Run & { heartbeatAt: Date | null })[] = [];
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
    const active = this.runs.filter((run) => isActive(run.state));
    if (active.length >= MAX_ACTIVE_RUNS) return Promise.resolve(null);
    const busy = new Set(active.map((run) => run.projectId));
    const next = this.runs.find((run) => run.state === 'queued' && !busy.has(run.projectId));
    if (!next) return Promise.resolve(null);
    Object.assign(next, {
      state: 'preparing',
      claimedBy: workerId,
      startedAt: now,
      heartbeatAt: now,
    });
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
      ...(change.workingCopy ? { workingCopy: structuredClone(change.workingCopy) } : {}),
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

  renewClaims(now: Date): Promise<number> {
    const held = this.runs.filter((run) => isClaimed(run.state));
    for (const run of held) run.heartbeatAt = now;
    return Promise.resolve(held.length);
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
    now: Date,
  ): Promise<AppendStepOutcome> {
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (!run || run.state !== 'running' || run.claimedBy !== workerId) {
      return Promise.resolve({ status: 'not_held' });
    }
    const index = this.steps.filter((stored) => stored.runId === runId).length + 1;
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
    this.steps.push({ runId, index, step: structuredClone(step) });
    run.workingCopy = structuredClone(workingCopy);
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

  failStaleClaims(staleBefore: Date, failure: RunFailure, now: Date): Promise<number> {
    const stale = this.runs.filter(
      (run) => isClaimed(run.state) && run.heartbeatAt !== null && run.heartbeatAt < staleBefore,
    );
    for (const run of stale) {
      Object.assign(run, {
        state: 'failed',
        failure,
        claimedBy: null,
        heartbeatAt: null,
        finishedAt: now,
      });
    }
    return Promise.resolve(stale.length);
  }

  private view(run: Run & { heartbeatAt: Date | null }): Run {
    const { heartbeatAt, ...rest } = run;
    void heartbeatAt; // internal: not part of a Run
    return structuredClone(rest);
  }
}
