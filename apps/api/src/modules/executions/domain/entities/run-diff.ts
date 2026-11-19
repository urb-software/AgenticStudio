import type { RunDiffData } from './run-diff-data.js';
import type { RunDiffReport } from './run-diff-facts.js';
import type { NewRunDiff } from '../value-objects/new-run-diff.js';
import type { RunDiffScope } from '../value-objects/run-diff-scope.js';
import { RunDiffState } from '../value-objects/run-diff-state.js';

/** A Run's diffs as the agent worker last reported them. */
export class RunDiff {
  private constructor(
    readonly runId: string,
    readonly diffs: Readonly<Record<RunDiffScope, NewRunDiff>>,
    readonly state: RunDiffState | null,
  ) {}

  static report(input: RunDiffReport): RunDiff {
    // The contract checked the format; checked again before it is kept.
    return new RunDiff(
      input.runId,
      input.diffs,
      input.state === null ? null : RunDiffState.of(input.state),
    );
  }

  static restore(data: RunDiffData): RunDiff {
    return new RunDiff(
      data.runId,
      data.diffs,
      data.state === null ? null : RunDiffState.restore(data.state),
    );
  }
}
