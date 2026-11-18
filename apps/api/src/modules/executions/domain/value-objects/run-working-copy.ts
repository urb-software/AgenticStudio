export interface RunCommit {
  id: string;
  subject: string;
}

export interface RunWorkingCopy {
  runBranch: string;
  commits: RunCommit[];
  hasUncommittedChanges: boolean;
}
