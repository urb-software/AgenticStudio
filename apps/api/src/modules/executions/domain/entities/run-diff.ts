import type { RunDiffSnapshot } from '../value-objects/run-diff-snapshot.js';
import type { NewRunDiff, RunDiffScope, RunDiffState } from '../value-objects/run-diff.js';

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * A Run's diffs as the agent worker last reported them (Issue #144): its two scopes and where they
 * stand, replacing the ones stored (the latest of each scope per Run). An aggregate root of its
 * own: it refers to its Run by id and holds nothing of the Run, so the report is stored in the
 * transaction that first checks, under the Run's lock, that the reporting worker holds the Run.
 *
 * It cannot be built in an invalid state: only {@link RunDiff.report} and {@link RunDiff.restore}
 * make one; a diff state that is not Git object ids is refused (review S-1 of #149).
 */
export class RunDiff {
  private constructor(
    readonly runId: string,
    readonly diffs: Readonly<Record<RunDiffScope, NewRunDiff>>,
    readonly state: RunDiffState | null,
  ) {}

  /** The diffs a worker reported for the Run (already redacted and shaped), with the state or `null`. */
  static report(input: RunDiffSnapshot): RunDiff {
    // The contract checked the format; checked again before it is kept (review S-1 of #149).
    if (input.state && !RunDiff.isState(input.state)) {
      throw new Error('The diff state is not object ids.');
    }
    return new RunDiff(input.runId, input.diffs, input.state);
  }

  /** Whether every id of a diff state is a full Git object id (40 or 64 lowercase hex). */
  static isState(state: RunDiffState): boolean {
    return [
      state.resultTree,
      state.resultCommit,
      state.previousTree,
      state.previousCommit,
      ...(state.pushedCommit === undefined ? [] : [state.pushedCommit]),
    ].every((id) => OBJECT_ID.test(id));
  }

  static restore(data: RunDiffSnapshot): RunDiff {
    return new RunDiff(data.runId, data.diffs, data.state);
  }

  snapshot(): RunDiffSnapshot {
    return { runId: this.runId, diffs: this.diffs, state: this.state };
  }
}
