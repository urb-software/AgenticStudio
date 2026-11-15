import { randomUUID } from 'node:crypto';
import {
  ACTIVE_RUN_STATES,
  CLAIMED_RUN_STATES,
  isFinal,
  MAX_ACTIVE_RUNS,
  type Run,
  type RunFailure,
  type RunState,
  type RunWorkingCopy,
} from '../../entities/run.js';
import type {
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
  readonly runs: (Run & { heartbeatAt: Date | null; environmentFileSecret: string | null })[] = [];
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
      environmentFileSupplied: false,
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
    if (!run || run.state !== change.from || run.claimedBy !== change.workerId) {
      return Promise.resolve(null);
    }
    const held = isClaimed(change.to);
    Object.assign(run, {
      state: change.to,
      failure: change.failure,
      claimedBy: held ? change.workerId : null,
      heartbeatAt: held ? change.now : null,
      finishedAt: isFinal(change.to) ? change.now : null,
      ...(change.workingCopy ? { workingCopy: structuredClone(change.workingCopy) } : {}),
    });
    return Promise.resolve(this.view(run));
  }

  heartbeat(runId: string, workerId: string, now: Date): Promise<boolean> {
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (!run || run.claimedBy !== workerId) return Promise.resolve(false);
    run.heartbeatAt = now;
    return Promise.resolve(true);
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
  ): Promise<number | null> {
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (!run || run.state !== 'running' || run.claimedBy !== workerId) {
      return Promise.resolve(null);
    }
    const index = this.steps.filter((stored) => stored.runId === runId).length + 1;
    this.steps.push({ runId, index, step: structuredClone(step) });
    run.workingCopy = structuredClone(workingCopy);
    return Promise.resolve(index);
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

  attachEnvironmentFile(runId: string, workerId: string, secretRef: string): Promise<boolean> {
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (!run || run.state !== 'preparing' || run.claimedBy !== workerId) {
      return Promise.resolve(false);
    }
    Object.assign(run, { environmentFileSupplied: true, environmentFileSecret: secretRef });
    return Promise.resolve(true);
  }

  findEnvironmentFileSecret(runId: string): Promise<string | null> {
    return Promise.resolve(
      this.runs.find((candidate) => candidate.id === runId)?.environmentFileSecret ?? null,
    );
  }

  listFinalEnvironmentFileSecrets(): Promise<{ runId: string; secretRef: string }[]> {
    return Promise.resolve(
      this.runs
        .filter((run) => isFinal(run.state) && run.environmentFileSecret !== null)
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

  private view(run: Run & { heartbeatAt: Date | null; environmentFileSecret: string | null }): Run {
    const { heartbeatAt, environmentFileSecret, ...rest } = run;
    // Internal: not part of a Run.
    void heartbeatAt;
    void environmentFileSecret;
    return structuredClone(rest);
  }
}
