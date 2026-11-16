import type {
  NewRunDiff,
  RunDiffFileView,
  RunDiffScope,
  StoredRunDiff,
} from '../entities/run-diff.js';

/** DI token for the {@link RunDiffRepository} adapter. */
export const RUN_DIFF_REPOSITORY = Symbol('RUN_DIFF_REPOSITORY');

/** The store of Runs' diffs (Issue #144): the latest diff of each scope per Run. */
export interface RunDiffRepository {
  /**
   * Replaces the Run's stored diffs with these, for a Run that `workerId` holds (`preparing` or
   * `running`, or `failed` and held for a delivery retry). Returns `false` if it does not hold
   * the Run (nothing is changed).
   */
  replace(
    runId: string,
    workerId: string,
    diffs: Record<RunDiffScope, NewRunDiff>,
    now: Date,
  ): Promise<boolean>;

  /** The Run's stored diff of `scope`, or `null` when none was reported. */
  find(runId: string, scope: RunDiffScope): Promise<StoredRunDiff | null>;

  /** One file of the Run's stored diff of `scope`, with its patch; `null` when it is not listed. */
  findFile(runId: string, scope: RunDiffScope, path: string): Promise<RunDiffFileView | null>;
}
