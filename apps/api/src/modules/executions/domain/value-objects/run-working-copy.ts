import type { RunCommit } from './run-commit.js';

export interface RunWorkingCopy {
  runBranch: string;
  commits: readonly RunCommit[];
  hasUncommittedChanges: boolean;
}
