import type { RunDiffFileStatus } from './run-diff-file-status.js';

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
