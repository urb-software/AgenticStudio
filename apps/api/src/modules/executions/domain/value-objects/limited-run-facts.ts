import type { RunState } from './run-state.js';

export interface LimitedRunFacts {
  state: RunState;
  finishedAt: Date | null;
  hasPullRequest: boolean;
  hasWorkingCopy: boolean;
  workingCopyRemoved: boolean;
}
