import type { FollowUpRefusal } from './follow-up-refusal.js';
import {
  isEndedPullRequestState,
  type EndedPullRequestState,
  type PullRequestState,
} from './pull-request-state.js';
import type { RunPullRequestChecks } from './run-pull-request-checks.js';
import type { PullRequestStateResult } from './pull-request-state-result.js';
import type { StoredPullRequestStatus } from './stored-pull-request-status.js';

export type FailingChecksPreparation = 'preparing' | 'ready' | 'failed';

const PAGE_REFRESH_MIN_AGE_SECONDS = 60;

export class RunPullRequestStatus {
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
   * `null` also while its state is unknown (a reopened pull request is open again
   * at the next lookup).
   */
  get followUpRefusal(): FollowUpRefusal | null {
    return isEndedPullRequestState(this.state)
      ? RunPullRequestStatus.ENDED_REFUSALS[this.state]
      : null;
  }

  get hasFailedCheck(): boolean {
    const checks = this.checks;
    return (
      checks !== null &&
      !checks.unavailable &&
      checks.checks.some((check) => check.state === 'failed')
    );
  }

  pageRefreshDue(now: Date): boolean {
    if (this.refreshRequestedAt !== null) return false;
    if (this.retryAt !== null && this.retryAt.getTime() > now.getTime()) return false;
    // Counted from the last attempt, so a lookup that keeps failing is not repeated on every open.
    const lastAttempt = this.lastAttemptAt ?? this.refreshedAt;
    if (lastAttempt === null) return true;
    return now.getTime() - lastAttempt.getTime() >= PAGE_REFRESH_MIN_AGE_SECONDS * 1000;
  }

  /**
   * The first time it is read as merged, closed or missing is kept (retention counts from it);
   * reading it open or draft again clears it.
   */
  private endedAtFor(state: PullRequestState, now: Date): Date | null {
    return isEndedPullRequestState(state) ? (this.endedAt ?? now) : null;
  }

  refreshRequested(now: Date): RunPullRequestStatus {
    return this.with({ refreshRequestedAt: now, lastAttemptAt: now });
  }

  preparationRequested(now: Date): RunPullRequestStatus {
    return this.with({ prepareRequestedAt: now, prepareError: null });
  }

  /**
   * The answer's own fields are what is kept: a merged or missing pull request has no branch
   * position, a closed one no merge verdict, and only an open one has checks.
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

  preparationDone(): RunPullRequestStatus {
    return this.with({ prepareRequestedAt: null, prepareError: null });
  }

  /**
   * With a retry (`retryAt`, a rate limit) the Run stays refreshing,
   * from `requestedAt`, until then.
   */
  refreshFailed(error: string, retryAt: Date | null, requestedAt: Date): RunPullRequestStatus {
    return this.with({
      refreshError: error,
      retryAt,
      refreshRequestedAt: retryAt === null ? null : requestedAt,
    });
  }

  preparationFailed(error: string, retryAt: Date | null, requestedAt: Date): RunPullRequestStatus {
    return this.with({
      prepareError: error,
      prepareRequestedAt: retryAt === null ? null : requestedAt,
    });
  }

  /**
   * A merged, closed or missing pull request has no branch position, merge verdict or checks worth
   * keeping: those are cleared with the state (a closed one keeps its branch position).
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
