import { randomUUID } from 'node:crypto';
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
      error: null,
    });
    run.pullRequestStatus = { ...run.pullRequestStatus, refreshRequestedAt: now };
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
    if (!lookup || lookup.claimedBy !== workerId) return Promise.resolve('not_held');
    if (lookup.status === 'failed') return Promise.resolve('duplicate');
    if (lookup.status !== 'claimed') return Promise.resolve('not_held');
    const retryAt =
      retryInSeconds === null ? null : new Date(now.getTime() + retryInSeconds * 1000);
    lookup.error = error;
    if (retryAt === null) lookup.status = 'failed';
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

  listDueForDailyRefresh(refreshedBefore: Date, limit: number): Promise<string[]> {
    return Promise.resolve(
      this.runs.runs
        .filter(
          (run) =>
            run.pullRequest !== null &&
            run.workingCopy !== null &&
            run.pullRequestStatus.refreshRequestedAt === null &&
            (run.pullRequestStatus.state === null ||
              run.pullRequestStatus.state === 'draft' ||
              run.pullRequestStatus.state === 'open') &&
            (run.pullRequestStatus.refreshedAt === null ||
              run.pullRequestStatus.refreshedAt < refreshedBefore),
        )
        .slice(0, limit)
        .map((run) => run.id),
    );
  }
}
