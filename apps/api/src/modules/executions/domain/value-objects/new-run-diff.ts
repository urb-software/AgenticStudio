import type { RunDiffFileSummary } from './run-diff-file-summary.js';

export type NewRunDiff =
  | {
      kind: 'computed';
      baseCommit: string;
      includesUnpushed: boolean;
      truncated: boolean;
      files: (RunDiffFileSummary & { patch?: string })[];
    }
  | { kind: 'unavailable'; reason: string };
