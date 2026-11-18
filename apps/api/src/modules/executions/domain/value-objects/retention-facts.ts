import type { RunState } from './run-state.js';
import type { PullRequestState } from './pull-request-state.js';

export interface RetentionFacts {
  state: RunState;
  finishedAt: Date | null;
  hasPullRequest: boolean;
  /**
   * `null` (never read, or a lookup that never succeeded) counts as open: a Git host outage never
   * causes removal.
   */
  pullRequestState: PullRequestState | null;
  pullRequestEndedAt: Date | null;
  lastActivityAt: Date;
}
