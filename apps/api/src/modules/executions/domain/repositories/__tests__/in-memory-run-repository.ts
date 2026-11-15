import { randomUUID } from 'node:crypto';
import {
  ACTIVE_RUN_STATES,
  CLAIMED_RUN_STATES,
  isFinal,
  MAX_ACTIVE_RUNS,
  type Run,
  type RunFailure,
  type RunState,
} from '../../entities/run.js';
import type { ClaimedRunChange, NewRun, RunRepository, RunStepRecord } from '../run-repository.js';

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
    });
    return Promise.resolve(this.view(run));
  }

  heartbeat(runId: string, workerId: string, now: Date): Promise<boolean> {
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (!run || run.claimedBy !== workerId) return Promise.resolve(false);
    run.heartbeatAt = now;
    return Promise.resolve(true);
  }

  appendStep(runId: string, workerId: string, step: RunStepRecord): Promise<number | null> {
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (!run || run.state !== 'running' || run.claimedBy !== workerId) {
      return Promise.resolve(null);
    }
    const index = this.steps.filter((stored) => stored.runId === runId).length + 1;
    this.steps.push({ runId, index, step: structuredClone(step) });
    return Promise.resolve(index);
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
