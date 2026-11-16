import { randomUUID } from 'node:crypto';
import type { PullRequestState } from '../../entities/run.js';
import type {
  ClaimedLookup,
  LookupKind,
  PullRequestStateResult,
} from '../../entities/run-lookup.js';
import type {
  LookupAnswerOutcome,
  LookupRequestOutcome,
  RunLookupRepository,
} from '../run-lookup-repository.js';
import type { InMemoryRunRepository } from './in-memory-run-repository.js';

export interface FakeLookup {
  id: string;
  runId: string;
  kind: LookupKind;
  status: 'requested' | 'claimed' | 'done' | 'failed';
  requestedAt: Date;
  claimedBy: string | null;
  claimedAt: Date | null;
  retryAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
}

/**
 * In-memory adapter of {@link RunLookupRepository} for handler tests, with the database
 * adapter's rules: one open lookup per Run and kind, a claim older than the lease is handed out
 * again, a rate-limited lookup waits for its retry time, and an answer updates the Run's
 * pull request status in the given Run store.
 */
export class InMemoryRunLookupRepository implements RunLookupRepository {
  readonly lookups: FakeLookup[] = [];

  constructor(private readonly runs: InMemoryRunRepository) {}

  private run(runId: string) {
    return this.runs.runs.find((candidate) => candidate.id === runId);
  }

  request(runId: string, kind: LookupKind, now: Date): Promise<LookupRequestOutcome> {
    const run = this.run(runId);
    if (!run || run.pullRequest === null || run.workingCopy === null) {
      return Promise.resolve('not_possible');
    }
    if (
      this.lookups.some(
        (lookup) =>
          lookup.runId === runId &&
          lookup.kind === kind &&
          (lookup.status === 'requested' || lookup.status === 'claimed'),
      )
    ) {
      return Promise.resolve('open');
    }
    this.lookups.push({
      id: randomUUID(),
      runId,
      kind,
      status: 'requested',
      requestedAt: now,
      claimedBy: null,
      claimedAt: null,
      retryAt: null,
      finishedAt: null,
      error: null,
    });
    run.pullRequestStatus = {
      ...run.pullRequestStatus,
      refreshRequestedAt: now,
      lastAttemptAt: now,
    };
    return Promise.resolve('requested');
  }

  claim(
    workerId: string,
    now: Date,
    limit: number,
    leaseSeconds: number,
  ): Promise<ClaimedLookup[]> {
    for (const lookup of this.lookups) {
      if (
        lookup.status === 'claimed' &&
        lookup.claimedAt !== null &&
        now.getTime() - lookup.claimedAt.getTime() >= leaseSeconds * 1000
      ) {
        Object.assign(lookup, { status: 'requested', claimedBy: null, claimedAt: null });
      }
    }
    const claimed: ClaimedLookup[] = [];
    for (const lookup of this.lookups) {
      if (claimed.length >= limit) break;
      const run = this.run(lookup.runId);
      if (
        lookup.status !== 'requested' ||
        (lookup.retryAt !== null && lookup.retryAt.getTime() > now.getTime()) ||
        !run?.pullRequest ||
        !run.workingCopy
      ) {
        continue;
      }
      Object.assign(lookup, {
        status: 'claimed',
        claimedBy: workerId,
        claimedAt: now,
        retryAt: null,
      });
      claimed.push({
        id: lookup.id,
        kind: lookup.kind,
        runId: run.id,
        remoteUrl: run.remoteUrl,
        pullRequestNumber: run.pullRequest.number,
        runBranch: run.workingCopy.runBranch,
        integrationBranch: run.integrationBranch,
      });
    }
    return Promise.resolve(claimed);
  }

  completePullRequestState(
    lookupId: string,
    workerId: string,
    result: PullRequestStateResult,
    now: Date,
  ): Promise<LookupAnswerOutcome> {
    const lookup = this.lookups.find((candidate) => candidate.id === lookupId);
    if (!lookup || lookup.claimedBy !== workerId) return Promise.resolve('not_held');
    if (lookup.status === 'done') return Promise.resolve('duplicate');
    if (lookup.status !== 'claimed') return Promise.resolve('not_held');
    lookup.status = 'done';
    lookup.finishedAt = now;
    lookup.error = null;
    const run = this.run(lookup.runId);
    if (run) {
      run.pullRequestStatus = {
        state: result.state,
        behindBy: result.behindBy ?? null,
        aheadBy: result.aheadBy ?? null,
        mergeable: result.mergeable ?? null,
        refreshedAt: now,
        refreshError: null,
        retryAt: null,
        refreshRequestedAt: null,
        lastAttemptAt: run.pullRequestStatus.lastAttemptAt,
      };
    }
    return Promise.resolve('stored');
  }

  fail(
    lookupId: string,
    workerId: string,
    error: string,
    retryInSeconds: number | null,
    now: Date,
  ): Promise<LookupAnswerOutcome> {
    const lookup = this.lookups.find((candidate) => candidate.id === lookupId);
    if (!lookup) return Promise.resolve('not_held');
    if (lookup.status === 'requested' && lookup.retryAt !== null && lookup.error === error) {
      return Promise.resolve('duplicate');
    }
    if (lookup.claimedBy !== workerId) return Promise.resolve('not_held');
    if (lookup.status === 'failed') return Promise.resolve('duplicate');
    if (lookup.status !== 'claimed') return Promise.resolve('not_held');
    const retryAt =
      retryInSeconds === null ? null : new Date(now.getTime() + retryInSeconds * 1000);
    lookup.error = error;
    if (retryAt === null) Object.assign(lookup, { status: 'failed', finishedAt: now });
    else Object.assign(lookup, { status: 'requested', claimedBy: null, claimedAt: null, retryAt });
    const run = this.run(lookup.runId);
    if (run) {
      run.pullRequestStatus = {
        ...run.pullRequestStatus,
        refreshError: error,
        retryAt,
        refreshRequestedAt: retryAt === null ? null : lookup.requestedAt,
      };
    }
    return Promise.resolve('stored');
  }

  findKind(lookupId: string): Promise<LookupKind | null> {
    return Promise.resolve(this.lookups.find((lookup) => lookup.id === lookupId)?.kind ?? null);
  }

  recordObservedState(runId: string, state: PullRequestState, now: Date): Promise<void> {
    const run = this.run(runId);
    if (run?.pullRequest) {
      run.pullRequestStatus = {
        ...run.pullRequestStatus,
        state,
        refreshedAt: now,
        refreshError: null,
        retryAt: null,
      };
    }
    return Promise.resolve();
  }

  deleteFinishedBefore(before: Date): Promise<number> {
    const kept = this.lookups.filter(
      (lookup) => !(lookup.finishedAt !== null && lookup.finishedAt < before),
    );
    const removed = this.lookups.length - kept.length;
    this.lookups.splice(0, this.lookups.length, ...kept);
    return Promise.resolve(removed);
  }

  listDueForDailyRefresh(attemptedBefore: Date, limit: number): Promise<string[]> {
    return Promise.resolve(
      this.runs.runs
        .filter((run) => {
          const status = run.pullRequestStatus;
          const attempt = status.lastAttemptAt ?? status.refreshedAt;
          return (
            run.pullRequest !== null &&
            run.workingCopy !== null &&
            status.refreshRequestedAt === null &&
            (status.state === null || status.state === 'draft' || status.state === 'open') &&
            (attempt === null || attempt < attemptedBefore)
          );
        })
        .slice(0, limit)
        .map((run) => run.id),
    );
  }
}
