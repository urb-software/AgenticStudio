import type { NewRunDiff } from '../value-objects/new-run-diff.js';
import type { RunDiffScope } from '../value-objects/run-diff-scope.js';
import type { RunDiffStateInput } from '../value-objects/run-diff-state.js';

/** What a Run's reported diffs hold; {@link RunDiff.snapshot}. */
export interface RunDiffSnapshot {
  readonly runId: string;
  /** The latest diff of each scope, with each file's patch (redacted). */
  readonly diffs: Readonly<Record<RunDiffScope, NewRunDiff>>;
  /** Where the diffs stand for the next resume or delivery claim; `null` keeps the stored one. */
  readonly state: RunDiffStateInput | null;
}
