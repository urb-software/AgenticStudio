import type {
  NewRunDiff,
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
   * Replaces the Run's stored diffs with these, for a Run that `workerId` holds (`preparing` or
   * `running`, or `failed` and held for a delivery retry), and its diff state with `state`
   * (`null` keeps the stored state: an unavailable report). Returns `false` if it does not hold
   * the Run (nothing is changed).
   */
  replace(
    runId: string,
    workerId: string,
    diffs: Record<RunDiffScope, NewRunDiff>,
    state: RunDiffState | null,
    now: Date,
  ): Promise<boolean>;

  /** The Run's stored diff of `scope`, or `null` when none was reported. */
  find(runId: string, scope: RunDiffScope): Promise<StoredRunDiff | null>;

  /** One file of the Run's stored diff of `scope`, with its patch; `null` when it is not listed. */
  findFile(runId: string, scope: RunDiffScope, path: string): Promise<RunDiffFileView | null>;

  /** The Run's diff state, for a resume or delivery claim; `null` when none was reported. */
  findState(runId: string): Promise<RunDiffState | null>;
}
