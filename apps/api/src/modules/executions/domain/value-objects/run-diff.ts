/**
 * Patches are redacted like the log before they are stored. The domain owns these lists; a test
 * pins the worker protocol's and the HTTP contract's to them.
 */
export const RUN_DIFF_SCOPES = ['run', 'last'] as const;
export type RunDiffScope = (typeof RUN_DIFF_SCOPES)[number];

export const RUN_DIFF_FILE_STATUSES = ['added', 'modified', 'deleted', 'renamed'] as const;
export type RunDiffFileStatus = (typeof RUN_DIFF_FILE_STATUSES)[number];

/** As stored, after redaction (which can lengthen it). */
export const RUN_DIFF_UNAVAILABLE_MAX_LENGTH = 500;

export interface RunDiffFileSummary {
  path: string;
  previousPath?: string;
  status: RunDiffFileStatus;
  additions: number;
  deletions: number;
  binary?: true;
  tooLarge?: true;
  hasPatch: boolean;
}

export type NewRunDiff =
  | {
      kind: 'computed';
      baseCommit: string;
      includesUnpushed: boolean;
      truncated: boolean;
      files: (RunDiffFileSummary & { patch?: string })[];
    }
  | { kind: 'unavailable'; reason: string };

/**
 * Object ids only. Studio stores the pushed commit once, on the Run; the claim fills `pushedCommit`
 * from there, and what a worker sends with its diff state is not stored.
 */
export interface RunDiffState {
  resultTree: string;
  resultCommit: string;
  previousTree: string;
  previousCommit: string;
  pushedCommit?: string;
}
