import type { RunDiffSnapshot } from './run-diff-snapshot.js';
import type { NewRunDiff, RunDiffScope, RunDiffState } from '../value-objects/run-diff.js';

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** A Run's diffs as the agent worker last reported them. */
export class RunDiff {
  private constructor(
    readonly runId: string,
    readonly diffs: Readonly<Record<RunDiffScope, NewRunDiff>>,
    readonly state: RunDiffState | null,
  ) {}

  static report(input: RunDiffSnapshot): RunDiff {
    // The contract checked the format; checked again before it is kept.
    if (input.state && !RunDiff.isState(input.state)) {
      throw new Error('The diff state is not object ids.');
    }
    return new RunDiff(input.runId, input.diffs, input.state);
  }

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
