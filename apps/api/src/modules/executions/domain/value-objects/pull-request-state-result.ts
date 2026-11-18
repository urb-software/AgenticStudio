import type { PullRequestState } from './pull-request-state.js';
import type { PullRequestCheck } from './pull-request-check.js';

export interface PullRequestStateResult {
  state: PullRequestState;
  behindBy?: number;
  aheadBy?: number;
  mergeable?: boolean;
  checksCommit?: string;
  checks?: PullRequestCheck[];
  checksUnavailable?: true;
}
