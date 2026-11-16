/**
 * A Run's diff of one scope (Issue #144): `run`, everything the Run changed since its start
 * commit, or `last`, what changed since the previous result. The agent worker computes both
 * from the Working copy after every Run step's result; Studio keeps the latest of each, after
 * the Working copy is gone. The patches are redacted like the log before they are stored.
 *
 * The domain owns these lists; a test pins the worker protocol's and the HTTP contract's to them.
 */
export const RUN_DIFF_SCOPES = ['run', 'last'] as const;
export type RunDiffScope = (typeof RUN_DIFF_SCOPES)[number];

/** How a file changed. */
export const RUN_DIFF_FILE_STATUSES = ['added', 'modified', 'deleted', 'renamed'] as const;
export type RunDiffFileStatus = (typeof RUN_DIFF_FILE_STATUSES)[number];

/** Longest reason a diff could not be computed, as stored (after redaction, which can lengthen it). */
export const RUN_DIFF_UNAVAILABLE_MAX_LENGTH = 500;

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
 * it for the worker and hands it back with a resume or delivery claim; object ids only.
 */
export interface RunDiffState {
  resultTree: string;
  resultCommit: string;
  previousTree: string;
  previousCommit: string;
  pushedCommit?: string;
}

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Whether every id of a diff state is a full Git object id (40 or 64 lowercase hex). */
export function isRunDiffState(state: RunDiffState): boolean {
  return [
    state.resultTree,
    state.resultCommit,
    state.previousTree,
    state.previousCommit,
    ...(state.pushedCommit === undefined ? [] : [state.pushedCommit]),
  ].every((id) => OBJECT_ID.test(id));
}

/**
 * Whether a diff file's path is the Run's Environment file path (review L-3 of #149): compared
 * without a leading `./` or `/`, so another spelling of the same path is caught too.
 */
export function isEnvironmentFilePath(path: string, environmentFilePath: string | null): boolean {
  if (environmentFilePath === null) return false;
  const normalise = (value: string) => value.replace(/^(?:\.\/|\/)+/, '');
  return normalise(path) === normalise(environmentFilePath);
}
