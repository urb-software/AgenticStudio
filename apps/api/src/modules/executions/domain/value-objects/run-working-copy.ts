import type { RunCommit } from './run-commit.js';

export interface RunWorkingCopy {
  runBranch: string;
  commits: RunCommit[];
  hasUncommittedChanges: boolean;
}
