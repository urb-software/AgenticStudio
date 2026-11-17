import type { FollowUpRefusal } from './follow-up.js';

/**
 * Where a Run's pull request stands on the Git host (Issue #142): `draft` and `open` are open;
 * `merged` and `closed` are over; `missing` means the pull request, or the Run branch it came
 * from, no longer exists. The worker protocol's list is pinned to this one by a test.
 */
export const PULL_REQUEST_STATES = ['draft', 'open', 'merged', 'closed', 'missing'] as const;
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];

/** A pull request state that is an end: merged, closed or not found (Issue #143). */
export type EndedPullRequestState = Extract<PullRequestState, 'merged' | 'closed' | 'missing'>;

/** Whether a pull request state is an end: merged, closed or not found (Issue #143). */
export function isEndedPullRequestState(
  state: PullRequestState | null,
): state is EndedPullRequestState {
  return state === 'merged' || state === 'closed' || state === 'missing';
}

/**
 * How a Pull request check stands (Issue #145). The worker protocol's list is pinned to this one
 * by a test.
 */
export const PULL_REQUEST_CHECK_STATES = [
  'queued',
  'running',
  'passed',
  'failed',
  'skipped',
  'cancelled',
] as const;
export type PullRequestCheckState = (typeof PULL_REQUEST_CHECK_STATES)[number];

/** A Pull request check as the Git host reports it (Issue #145). */
export interface PullRequestCheck {
  name: string;
  state: PullRequestCheckState;
  durationSeconds?: number;
  url: string;
}

/**
 * The Pull request checks of the pull request's latest commit as the last state lookup read them
 * (Issue #145); `unavailable` when the Git host refused to tell them (the Agent account lacks the
 * permission). An empty list means none are configured or reported for that commit.
 */
export type RunPullRequestChecks =
  { unavailable: true } | { unavailable?: false; commit: string; checks: PullRequestCheck[] };

/**
 * Where the preparation of a Follow-up from failing checks stands (Issue #145): the worker is
 * reading the logs (`preparing`), a draft waits for the operator (`ready`) or the reading failed
 * (`failed`, with the reason in {@link StoredPullRequestStatus.prepareError}).
 */
export type FailingChecksPreparation = 'preparing' | 'ready' | 'failed';

/** What a worker found out about a pull request (Issue #142, #145). */
export interface PullRequestStateResult {
  state: PullRequestState;
  behindBy?: number;
  aheadBy?: number;
  mergeable?: boolean;
  /** Issue #145: the checks of the latest commit `checksCommit`, for a draft or open pull request. */
  checksCommit?: string;
  checks?: PullRequestCheck[];
  /** Issue #145: the Git host refused to tell the checks. */
  checksUnavailable?: true;
}

/**
 * What Studio knows about the Run's pull request (Issue #142), as storage holds it, from the
 * lookups the agent worker answered through the Agent account; Studio itself never reads the Git
 * host. `state` is `null` until the first lookup succeeded, and is kept when a later one fails
 * (`refreshError` then says why). Every field is `null` for a Run without a pull request.
 */
export interface StoredPullRequestStatus {
  state: PullRequestState | null;
  /** Commits the Run branch is behind / ahead of the integration branch at that lookup. */
  behindBy: number | null;
  aheadBy: number | null;
  /** Whether the Git host said it can be merged without conflicts; `null` when it did not say. */
  mergeable: boolean | null;
  /** When the state was read. */
  refreshedAt: Date | null;
  /** Why the latest lookup failed; cleared by a success. */
  refreshError: string | null;
  /** A rate-limited lookup is tried again at this time. */
  retryAt: Date | null;
  /** Set while a lookup waits for an agent worker or is being answered. */
  refreshRequestedAt: Date | null;
  /** When a lookup was last requested, whether or not it succeeded (review S1 of #152). */
  lastAttemptAt: Date | null;
  /** Issue #145: the Pull request checks of the latest commit; `null` until read. */
  checks: RunPullRequestChecks | null;
  /** Issue #145: set while a preparation of failing checks waits for a worker or is answered. */
  prepareRequestedAt: Date | null;
  /** Issue #145: why the latest preparation failed; cleared by a new request or a success. */
  prepareError: string | null;
  /**
   * Issue #143: when a lookup first read the pull request as merged, closed or missing; `null`
   * while it is not over (a reopened one is cleared). Working copy retention counts from it.
   */
  endedAt: Date | null;
}

/** Opening the Run page requests a refresh only if the state is older than this. */
const PAGE_REFRESH_MIN_AGE_SECONDS = 60;

/**
 * The state of a Run's pull request on the Git host, as Studio last read it (Issue #142): where
 * it stands, its position behind and ahead of the integration branch, the merge verdict, the
 * Pull request checks, and the bookkeeping of the lookups that read them. A change returns a new
 * status.
 */
export class RunPullRequestStatus {
  /** The Follow-up refusal for each state in which no pull request is left to update. */
  static readonly ENDED_REFUSALS = {
    merged: 'pull_request_merged',
    closed: 'pull_request_closed',
    missing: 'pull_request_missing',
  } as const satisfies Record<EndedPullRequestState, FollowUpRefusal>;

  readonly state: PullRequestState | null;
  readonly behindBy: number | null;
  readonly aheadBy: number | null;
  readonly mergeable: boolean | null;
  readonly refreshedAt: Date | null;
  readonly refreshError: string | null;
  readonly retryAt: Date | null;
  readonly refreshRequestedAt: Date | null;
  readonly lastAttemptAt: Date | null;
  readonly checks: RunPullRequestChecks | null;
  readonly prepareRequestedAt: Date | null;
  readonly prepareError: string | null;
  readonly endedAt: Date | null;

  private constructor(stored: StoredPullRequestStatus) {
    this.state = stored.state;
    this.behindBy = stored.behindBy;
    this.aheadBy = stored.aheadBy;
    this.mergeable = stored.mergeable;
    this.refreshedAt = stored.refreshedAt;
    this.refreshError = stored.refreshError;
    this.retryAt = stored.retryAt;
    this.refreshRequestedAt = stored.refreshRequestedAt;
    this.lastAttemptAt = stored.lastAttemptAt;
    this.checks = stored.checks;
    this.prepareRequestedAt = stored.prepareRequestedAt;
    this.prepareError = stored.prepareError;
    this.endedAt = stored.endedAt;
  }

  /** No lookup yet: what a Run starts with. */
  static none(): RunPullRequestStatus {
    return new RunPullRequestStatus({
      state: null,
      behindBy: null,
      aheadBy: null,
      mergeable: null,
      refreshedAt: null,
      refreshError: null,
      retryAt: null,
      refreshRequestedAt: null,
      lastAttemptAt: null,
      checks: null,
      prepareRequestedAt: null,
      prepareError: null,
      endedAt: null,
    });
  }

  static restore(stored: StoredPullRequestStatus): RunPullRequestStatus {
    return new RunPullRequestStatus(stored);
  }

  toStored(): StoredPullRequestStatus {
    return {
      state: this.state,
      behindBy: this.behindBy,
      aheadBy: this.aheadBy,
      mergeable: this.mergeable,
      refreshedAt: this.refreshedAt,
      refreshError: this.refreshError,
      retryAt: this.retryAt,
      refreshRequestedAt: this.refreshRequestedAt,
      lastAttemptAt: this.lastAttemptAt,
      checks: this.checks,
      prepareRequestedAt: this.prepareRequestedAt,
      prepareError: this.prepareError,
      endedAt: this.endedAt,
    };
  }

  private with(patch: Partial<StoredPullRequestStatus>): RunPullRequestStatus {
    return new RunPullRequestStatus({ ...this.toStored(), ...patch });
  }

  /**
   * The Follow-up refusal the pull request's state calls for (Issue #142): nothing to update once
   * it is merged, closed or missing; `null` otherwise, also while its state is unknown (a
   * reopened pull request is open again at the next lookup).
   */
  get followUpRefusal(): FollowUpRefusal | null {
    return isEndedPullRequestState(this.state)
      ? RunPullRequestStatus.ENDED_REFUSALS[this.state]
      : null;
  }

  /** Whether the stored Pull request checks include a failed one (Issue #145). */
  get hasFailedCheck(): boolean {
    const checks = this.checks;
    return (
      checks !== null &&
      !checks.unavailable &&
      checks.checks.some((check) => check.state === 'failed')
    );
  }

  /**
   * Whether opening the Run page should request a refresh (Issue #142): never more often than
   * once a minute (from the last attempt, successful or not), and not while a lookup is open or
   * a rate limit asks to wait.
   */
  pageRefreshDue(now: Date): boolean {
    if (this.refreshRequestedAt !== null) return false;
    if (this.retryAt !== null && this.retryAt.getTime() > now.getTime()) return false;
    // Counted from the last attempt, so a lookup that keeps failing is not repeated on every open.
    const lastAttempt = this.lastAttemptAt ?? this.refreshedAt;
    if (lastAttempt === null) return true;
    return now.getTime() - lastAttempt.getTime() >= PAGE_REFRESH_MIN_AGE_SECONDS * 1000;
  }

  /**
   * When a pull request was first read as over (Issue #143): the first time it is read as merged,
   * closed or missing is kept (the retention period counts from it); reading it open or draft
   * again (a reopened pull request) clears it.
   */
  private endedAtFor(state: PullRequestState, now: Date): Date | null {
    return isEndedPullRequestState(state) ? (this.endedAt ?? now) : null;
  }

  /**
   * A lookup of the pull request's state was requested (Issue #142): the Run is refreshing from
   * `now` on, and the attempt counts for the page-open throttle.
   */
  refreshRequested(now: Date): RunPullRequestStatus {
    return this.with({ refreshRequestedAt: now, lastAttemptAt: now });
  }

  /**
   * The reading of the failing checks' logs was requested (Issue #145): the Run is preparing from
   * `now` on, the last preparation's error cleared. The state refresh's throttle is left alone.
   */
  preparationRequested(now: Date): RunPullRequestStatus {
    return this.with({ prepareRequestedAt: now, prepareError: null });
  }

  /**
   * What a worker read of the pull request's state replaces what Studio knows (Issues #142, #143,
   * #145): the state, the branch position, the merge verdict, the Pull request checks and the read
   * time; the error, the retry time and the refreshing mark are cleared. The answer's own fields
   * are what is kept: a merged or missing pull request has no branch position, a closed one no
   * merge verdict, and only an open one has checks. The time the pull request was first read as
   * over is kept, and a reopened one clears it.
   */
  read(result: PullRequestStateResult, now: Date): RunPullRequestStatus {
    return this.with({
      state: result.state,
      behindBy: result.behindBy ?? null,
      aheadBy: result.aheadBy ?? null,
      mergeable: result.mergeable ?? null,
      refreshedAt: now,
      refreshError: null,
      retryAt: null,
      refreshRequestedAt: null,
      checks:
        result.checksUnavailable === true
          ? { unavailable: true }
          : result.checks !== undefined && result.checksCommit !== undefined
            ? { commit: result.checksCommit, checks: result.checks }
            : null,
      endedAt: this.endedAtFor(result.state, now),
    });
  }

  /** A prepared Follow-up was stored for the Run (Issue #145): it is no longer preparing. */
  preparationDone(): RunPullRequestStatus {
    return this.with({ prepareRequestedAt: null, prepareError: null });
  }

  /**
   * A lookup of the pull request's state failed (Issue #142): the Run keeps its last known state
   * and gets `error`. With a retry (`retryAt`, a rate limit) it stays refreshing, from
   * `requestedAt`, until then.
   */
  refreshFailed(error: string, retryAt: Date | null, requestedAt: Date): RunPullRequestStatus {
    return this.with({
      refreshError: error,
      retryAt,
      refreshRequestedAt: retryAt === null ? null : requestedAt,
    });
  }

  /** The reading of the failing checks' logs failed (Issue #145); as {@link refreshFailed}. */
  preparationFailed(error: string, retryAt: Date | null, requestedAt: Date): RunPullRequestStatus {
    return this.with({
      prepareError: error,
      prepareRequestedAt: retryAt === null ? null : requestedAt,
    });
  }

  /**
   * The state of the pull request a worker read on its own, right before it refused a Follow-up
   * (review S4 of #152): the state and its read time replace the Run's, the error is cleared. A
   * merged, closed or missing pull request has no branch position, merge verdict or checks worth
   * keeping (review N1 of #152): those are cleared with the state (a closed one keeps its branch
   * position).
   */
  observed(state: PullRequestState, now: Date): RunPullRequestStatus {
    const gone = state === 'merged' || state === 'missing';
    const over = gone || state === 'closed';
    return this.with({
      state,
      refreshedAt: now,
      refreshError: null,
      retryAt: null,
      behindBy: gone ? null : this.behindBy,
      aheadBy: gone ? null : this.aheadBy,
      mergeable: over ? null : this.mergeable,
      checks: over ? null : this.checks,
      endedAt: this.endedAtFor(state, now),
    });
  }
}
