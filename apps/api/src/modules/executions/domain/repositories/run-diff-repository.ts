import type { RunDiff } from '../entities/run-diff.js';
import type { RunDiffFileSummary } from '../value-objects/run-diff-file-summary.js';
import type { RunDiffScope } from '../value-objects/run-diff-scope.js';
import type { RunDiffState } from '../value-objects/run-diff-state.js';

export const RUN_DIFF_REPOSITORY = Symbol('RUN_DIFF_REPOSITORY');

/** A reported diff as the diff view shows it; `reportedAt` is when the store recorded it. */
export type RunDiffView =
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
  find(runId: string, scope: RunDiffScope): Promise<RunDiffView | null>;

  /** `null` when the file is not listed. */
  findFile(runId: string, scope: RunDiffScope, path: string): Promise<RunDiffFileView | null>;

  /** `null` when none was reported. */
  findState(runId: string): Promise<RunDiffState | null>;
}
