import type { PullRequestState } from './pull-request-state.js';

export interface PullRequestRefreshFacts {
  id: string;
  hasPullRequest: boolean;
  hasWorkingCopy: boolean;
  refreshRequestedAt: Date | null;
  pullRequestState: PullRequestState | null;
  lastAttemptAt: Date | null;
  refreshedAt: Date | null;
}
