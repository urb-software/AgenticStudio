/** One commit on a Run branch: its id and subject line. */
export interface RunCommit {
  id: string;
  subject: string;
}

/**
 * The Working copy's state as the agent worker last reported it after a Run step (Issue #98):
 * the Run branch, its commits since the start commit (oldest first, capped by the worker
 * protocol) and whether uncommitted changes remain.
 */
export interface RunWorkingCopy {
  runBranch: string;
  commits: RunCommit[];
  hasUncommittedChanges: boolean;
}
