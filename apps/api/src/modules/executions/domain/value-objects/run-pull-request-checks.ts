import type { PullRequestCheck } from './pull-request-check.js';

/**
 * `unavailable`: the Git host refused to tell them (the Agent account lacks the permission). An
 * empty list means none are configured or reported for that commit.
 */
export type RunPullRequestChecks =
  { unavailable: true } | { unavailable?: false; commit: string; checks: PullRequestCheck[] };
