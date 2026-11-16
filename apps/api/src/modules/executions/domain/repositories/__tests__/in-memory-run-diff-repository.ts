import { CLAIMED_RUN_STATES } from '../../entities/run.js';
import type {
  NewRunDiff,
  RunDiffFileView,
  RunDiffScope,
  StoredRunDiff,
} from '../../entities/run-diff.js';
import type { RunDiffRepository } from '../run-diff-repository.js';
import type { InMemoryRunRepository } from './in-memory-run-repository.js';

/**
 * In-memory adapter of {@link RunDiffRepository} for handler tests, with the database adapter's
 * rules: only the holding worker replaces a Run's diffs (also of a failed Run held for a
 * delivery retry), and a report replaces both scopes.
 */
export class InMemoryRunDiffRepository implements RunDiffRepository {
  readonly diffs = new Map<string, Record<RunDiffScope, NewRunDiff & { reportedAt: Date }>>();

  constructor(private readonly runs: InMemoryRunRepository) {}

  replace(
    runId: string,
    workerId: string,
    diffs: Record<RunDiffScope, NewRunDiff>,
    now: Date,
  ): Promise<boolean> {
    const run = this.runs.runs.find((candidate) => candidate.id === runId);
    const held =
      (CLAIMED_RUN_STATES as readonly string[]).includes(run?.state ?? '') ||
      (run?.state === 'failed' && run.deliveryRequested);
    if (!run || !held || run.claimedBy !== workerId) return Promise.resolve(false);
    this.diffs.set(runId, {
      run: { ...structuredClone(diffs.run), reportedAt: now },
      last: { ...structuredClone(diffs.last), reportedAt: now },
    });
    return Promise.resolve(true);
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
}
