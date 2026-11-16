import type { RunDiffFileStatus, RunDiffScope } from '@agentic-studio/contracts';

/**
 * A Run's diff of one scope (Issue #144): `run`, everything the Run changed since its start
 * commit, or `last`, what changed since the previous result. The agent worker computes both
 * from the Working copy after every Run step's result; Studio keeps the latest of each, after
 * the Working copy is gone. The patches are redacted like the log before they are stored.
 */
export type { RunDiffScope };

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
