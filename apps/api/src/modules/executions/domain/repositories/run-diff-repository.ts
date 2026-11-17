import type { RunDiff } from '../entities/run-diff.js';
import type {
  RunDiffFileView,
  RunDiffScope,
  RunDiffState,
  StoredRunDiff,
} from '../value-objects/run-diff.js';

/** DI token for the {@link RunDiffRepository} adapter. */
export const RUN_DIFF_REPOSITORY = Symbol('RUN_DIFF_REPOSITORY');

/** The store of Runs' diffs (Issue #144): the latest diff of each scope per Run, and its state. */
export interface RunDiffRepository {
  /**
   * Replaces the Run's stored diffs with the reported ones, and its diff state with the report's
   * (`null` keeps the stored state: an unavailable report). That the reporting worker holds the
   * Run is the Run's rule, checked by the caller under the Run's lock in the same transaction.
   */
  replace(diff: RunDiff, now: Date): Promise<void>;

  /** The Run's stored diff of `scope`, or `null` when none was reported. */
  find(runId: string, scope: RunDiffScope): Promise<StoredRunDiff | null>;

  /** One file of the Run's stored diff of `scope`, with its patch; `null` when it is not listed. */
  findFile(runId: string, scope: RunDiffScope, path: string): Promise<RunDiffFileView | null>;

  /** The Run's diff state, for a resume or delivery claim; `null` when none was reported. */
  findState(runId: string): Promise<RunDiffState | null>;
}
