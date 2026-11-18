import type { RunDiff } from '../../entities/run-diff.js';
import type { RunDiffScope } from '../../value-objects/run-diff.js';
import type { NewRunDiff, RunDiffState } from '../../value-objects/run-diff.js';
import type { RunDiffFileView, StoredRunDiff } from '../run-diff-repository.js';
import type { RunDiffRepository } from '../run-diff-repository.js';

/**
 * In-memory {@link RunDiffRepository}: a report replaces both scopes, and `null` keeps the stored
 * state.
 */
export class InMemoryRunDiffRepository implements RunDiffRepository {
  readonly diffs = new Map<string, Record<RunDiffScope, NewRunDiff & { reportedAt: Date }>>();
  readonly states = new Map<string, RunDiffState>();

  replace(report: RunDiff, now: Date): Promise<void> {
    const { runId, diffs, state } = report;
    this.diffs.set(runId, {
      run: { ...structuredClone(diffs.run), reportedAt: now },
      last: { ...structuredClone(diffs.last), reportedAt: now },
    });
    if (state) this.states.set(runId, structuredClone(state));
    return Promise.resolve();
  }

  find(runId: string, scope: RunDiffScope): Promise<StoredRunDiff | null> {
    const diff = this.diffs.get(runId)?.[scope];
    if (!diff) return Promise.resolve(null);
    if (diff.kind === 'unavailable') return Promise.resolve(structuredClone(diff));
    return Promise.resolve({
      ...structuredClone(diff),
      files: diff.files.map(({ patch, ...file }) => {
        void patch;
        return structuredClone(file);
      }),
    });
  }

  findFile(runId: string, scope: RunDiffScope, path: string): Promise<RunDiffFileView | null> {
    const diff = this.diffs.get(runId)?.[scope];
    if (!diff || diff.kind === 'unavailable') return Promise.resolve(null);
    const file = diff.files.find((candidate) => candidate.path === path);
    return Promise.resolve(file ? structuredClone(file) : null);
  }

  findState(runId: string): Promise<RunDiffState | null> {
    const state = this.states.get(runId);
    return Promise.resolve(state ? structuredClone(state) : null);
  }
}
