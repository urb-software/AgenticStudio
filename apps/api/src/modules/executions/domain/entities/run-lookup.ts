import type { PullRequestState, Run } from './run.js';

/**
 * Lookups (Issue #142): Studio's questions for the Git host that only an agent worker can
 * answer, through the Agent account; Studio itself never reads the Git host. The kinds start
 * with the pull request's state; later stories add theirs. The worker protocol's lists are
 * pinned to these by a test.
 */
export const LOOKUP_KINDS = ['pull_request_state'] as const;
export type LookupKind = (typeof LOOKUP_KINDS)[number];

/** A lookup is open while it waits for a worker (`requested`) or is being answered (`claimed`). */
export const LOOKUP_STATUSES = ['requested', 'claimed', 'done', 'failed'] as const;
export type LookupStatus = (typeof LOOKUP_STATUSES)[number];

/** A claimed lookup goes back to `requested` when its worker has not answered within this. */
export const LOOKUP_LEASE_SECONDS = 120;

/** Most lookups one claim hands out. */
export const LOOKUP_CLAIM_LIMIT = 5;

/** Opening the Run page requests a refresh only if the state is older than this. */
export const PAGE_REFRESH_MIN_AGE_SECONDS = 60;

/** The daily refresh looks again at a state older than this. */
export const DAILY_REFRESH_AGE_HOURS = 24;

/** Most Runs one pass of the daily refresh requests; the rest follow at the next pass. */
export const DAILY_REFRESH_BATCH = 200;

/** Longest a rate-limited lookup waits before it is tried again, whatever the Git host says. */
export const LOOKUP_RETRY_AFTER_MAX_SECONDS = 60 * 60;

/** A lookup a worker claimed: what it needs to answer, nothing more. */
export interface ClaimedLookup {
  id: string;
  kind: LookupKind;
  runId: string;
  remoteUrl: string;
  pullRequestNumber: number;
  runBranch: string;
  integrationBranch: string;
}

/** What a worker found out about a pull request. */
export interface PullRequestStateResult {
  state: PullRequestState;
  behindBy?: number;
  aheadBy?: number;
  mergeable?: boolean;
}

export type LookupFailureCode = 'scope_mismatch' | 'rate_limited' | 'failed';

/** Why a lookup failed, in the worker's words (redacted before it is stored). */
export interface LookupFailure {
  code: LookupFailureCode;
  error: string;
  retryAfterSeconds?: number;
}

/**
 * Whether a Run's pull request can be looked up: it has one, and its Run branch is known (the
 * lookup is limited to that branch).
 */
export function canRefreshPullRequest(run: Pick<Run, 'pullRequest' | 'workingCopy'>): boolean {
  return run.pullRequest !== null && run.workingCopy !== null;
}

/**
 * Whether opening the Run page should request a refresh (Issue #142): never more often than
 * once a minute per Run, and not while a lookup is open or a rate limit asks to wait.
 */
export function pageRefreshDue(run: Pick<Run, 'pullRequestStatus'>, now: Date): boolean {
  const status = run.pullRequestStatus;
  if (status.refreshRequestedAt !== null) return false;
  if (status.retryAt !== null && status.retryAt.getTime() > now.getTime()) return false;
  if (status.refreshedAt === null) return true;
  return now.getTime() - status.refreshedAt.getTime() >= PAGE_REFRESH_MIN_AGE_SECONDS * 1000;
}

/** How long to wait before a rate-limited lookup is tried again, bounded. */
export function retryDelaySeconds(failure: LookupFailure): number | null {
  if (failure.code !== 'rate_limited') return null;
  return Math.min(Math.max(failure.retryAfterSeconds ?? 60, 1), LOOKUP_RETRY_AFTER_MAX_SECONDS);
}
