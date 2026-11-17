import type { RunDiffFileStatus, RunDiffScope } from '../value-objects/run-diff.js';

/** One changed file of a stored diff; its patch, if it has one, is stored apart. */
export interface RunDiffFileSummary {
  path: string;
  previousPath?: string;
  status: RunDiffFileStatus;
  additions: number;
  deletions: number;
  binary?: true;
  tooLarge?: true;
  /** Whether a patch is stored: false for a binary or too large file, or one over the total. */
  hasPatch: boolean;
}

/** A stored diff: computed (with its base commit) or `unavailable` with the worker's reason. */
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

/** A diff as the store takes it: the file list with each file's patch (redacted). */
export type NewRunDiff =
  | {
      kind: 'computed';
      baseCommit: string;
      includesUnpushed: boolean;
      truncated: boolean;
      files: (RunDiffFileSummary & { patch?: string })[];
    }
  | { kind: 'unavailable'; reason: string };

/** One file of a stored diff with its patch, if one is stored. */
export interface RunDiffFileView extends RunDiffFileSummary {
  patch?: string;
}

/**
 * Where a Run's diffs stand (review S-1 of #149): the snapshot tree and commit of the latest
 * result and of the one before it, and the Run branch tip the worker last pushed. Studio keeps
 * it for the worker and hands it back with a resume or delivery claim; object ids only. Issue
 * #143: Studio stores the pushed commit once, on the Run (`Run.pushedCommit`); the claim fills
 * `pushedCommit` from there, and what a worker sends with its diff state is not stored.
 */
export interface RunDiffState {
  resultTree: string;
  resultCommit: string;
  previousTree: string;
  previousCommit: string;
  pushedCommit?: string;
}

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** What a Run's reported diffs hold, as read-only plain data (rule 10); {@link RunDiff.snapshot}. */
export interface RunDiffSnapshot {
  readonly runId: string;
  /** The latest diff of each scope, with each file's patch (redacted). */
  readonly diffs: Readonly<Record<RunDiffScope, NewRunDiff>>;
  /** Where the diffs stand for the next resume or delivery claim; `null` keeps the stored one. */
  readonly state: RunDiffState | null;
}

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
