import type { RunDiff } from '../entities/run-diff.js';
import type { RunDiffSnapshot } from '../entities/run-diff-snapshot.js';
import type { RunDiffFileSummary, RunDiffScope } from '../value-objects/run-diff.js';

export const RUN_DIFF_REPOSITORY = Symbol('RUN_DIFF_REPOSITORY');

export type StoredRunDiff =
  | {
      kind: 'computed';
      baseCommit: string;
      includesUnpushed: boolean;
      truncated: boolean;
      files: RunDiffFileSummary[];
      reportedAt: Date;
    }
  | { kind: 'unavailable'; reason: string; reportedAt: Date };

export interface RunDiffFileView extends RunDiffFileSummary {
  patch?: string;
}

export interface RunDiffRepository {
  /**
   * `null` state keeps the stored one. The caller checks, under the Run's lock in the same
   * transaction, that the reporting worker holds the Run.
   */
  replace(diff: RunDiff, now: Date): Promise<void>;

  /** `null` when none was reported. */
  find(runId: string, scope: RunDiffScope): Promise<StoredRunDiff | null>;

  /** `null` when the file is not listed. */
  findFile(runId: string, scope: RunDiffScope, path: string): Promise<RunDiffFileView | null>;

  /** `null` when none was reported. */
  findState(runId: string): Promise<RunDiffSnapshot['state']>;
}
