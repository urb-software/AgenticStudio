export const MERGE_HOST = Symbol('MERGE_HOST');

/**
 * The pull request a call is about. The host answers `scope_mismatch`, and writes nothing, unless
 * `runBranch` is the Run's own branch and the pull request's head is that branch in the
 * repository `remoteUrl` names.
 */
export interface PullRequestScope {
  remoteUrl: string;
  runId: string;
  integrationBranch: string;
  runBranch: string;
  pullRequestNumber: number;
}

export type MergeHostFailure =
  | { code: 'not_configured' }
  | { code: 'unsupported_host' }
  | { code: 'scope_mismatch' }
  | { code: 'not_found' }
  | { code: 'rate_limited'; retryAfterSeconds: number }
  /** `message` is the host's own, redacted and at most 500 characters. */
  | { code: 'refused'; message: string }
  /** A network error, a timeout or a 5xx answer. */
  | { code: 'unavailable' };

export type MergeHostResult<T = Record<never, never>> =
  ({ ok: true } & T) | { ok: false; failure: MergeHostFailure };

export type HostPullRequestState = 'open' | 'closed' | 'merged';
export type HostCheckState = 'success' | 'failure' | 'pending' | 'neutral';
export type HostMergeMethod = 'squash' | 'merge_commit';

export interface HostPullRequest {
  state: HostPullRequestState;
  draft: boolean;
  headSha: string;
  headRef: string;
  baseRef: string;
  /** `null` while the host has not computed it yet. */
  mergeable: boolean | null;
  mergeableState: string;
  title: string;
  /** The description; empty when there is none. */
  body: string;
}

export interface HostCheck {
  name: string;
  state: HostCheckState;
}

export interface HostMergeRequest {
  sha: string;
  method: HostMergeMethod;
  title?: string;
  message?: string;
}

/**
 * Studio's own Git host credential, for an operator's merge or close only. No method throws for
 * a host error, and none is reachable from a worker route.
 */
export interface MergeHost {
  readPullRequest(
    scope: PullRequestScope,
  ): Promise<MergeHostResult<{ pullRequest: HostPullRequest }>>;

  /** The check runs and commit statuses of `sha`, merged into one list. */
  readChecks(
    scope: PullRequestScope,
    sha: string,
  ): Promise<MergeHostResult<{ checks: HostCheck[] }>>;

  markReady(scope: PullRequestScope): Promise<MergeHostResult>;

  /** An approving review pinned to `sha`. */
  approve(scope: PullRequestScope, sha: string): Promise<MergeHostResult>;

  /** Sends `sha`, so the host refuses when the head moved. `mergedCommit` is the commit it created. */
  merge(
    scope: PullRequestScope,
    request: HostMergeRequest,
  ): Promise<MergeHostResult<{ mergedCommit: string }>>;

  /** Closes the pull request without merging. */
  close(scope: PullRequestScope): Promise<MergeHostResult>;

  /** Deletes `refs/heads/<runBranch>` and no other branch. */
  deleteRunBranch(scope: PullRequestScope): Promise<MergeHostResult>;
}
