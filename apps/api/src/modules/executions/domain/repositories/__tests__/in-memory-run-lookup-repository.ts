import { RunLookup } from '../../entities/run-lookup.js';
import { type RunLookupSnapshot } from '../../entities/run-lookup-snapshot.js';
import type { LookupHandOutRule } from '../../value-objects/lookup-hand-out-rule.js';
import type { ReviewCommentsLoad } from '../run-lookup-repository.js';
import type { LookupKind } from '../../value-objects/run-lookup.js';
import type { ClaimedLookup } from '../run-lookup-repository.js';
import type { RunLookupRepository } from '../run-lookup-repository.js';
import type { InMemoryRunRepository } from './in-memory-run-repository.js';

/** Plain and mutable, so a test can set a lookup up in any state. */
export type FakeLookup = {
  -readonly [K in keyof Omit<RunLookupSnapshot, 'result'>]: RunLookupSnapshot[K];
} & { result?: unknown };

const entity = (stored: FakeLookup): RunLookup =>
  RunLookup.restore({ ...stored, result: stored.result ?? null });

/** In-memory {@link RunLookupRepository}: one open lookup per Run and kind; the hand-out follows {@link LookupHandOutRule}. */
export class InMemoryRunLookupRepository implements RunLookupRepository {
  readonly lookups: FakeLookup[] = [];

  constructor(private readonly runs: InMemoryRunRepository) {}

  add(lookup: RunLookup): Promise<void> {
    this.lookups.push(lookup.snapshot());
    return Promise.resolve();
  }

  save(lookup: RunLookup): Promise<void> {
    const stored = this.lookups.find((candidate) => candidate.id === lookup.id);
    if (stored) Object.assign(stored, lookup.snapshot());
    return Promise.resolve();
  }

  findById(id: string): Promise<RunLookup | null> {
    const stored = this.lookups.find((candidate) => candidate.id === id);
    return Promise.resolve(stored ? entity(stored) : null);
  }

  findByIdForUpdate(id: string): Promise<RunLookup | null> {
    return this.findById(id);
  }

  findOpen(runId: string, kind: LookupKind): Promise<RunLookup | null> {
    const stored = this.lookups.find(
      (lookup) =>
        lookup.runId === runId &&
        lookup.kind === kind &&
        (lookup.status === 'requested' || lookup.status === 'claimed'),
    );
    return Promise.resolve(stored ? entity(stored) : null);
  }

  claim(workerId: string, rule: LookupHandOutRule): Promise<ClaimedLookup[]> {
    for (const lookup of this.lookups) {
      if (rule.claimExpired(lookup)) {
        Object.assign(lookup, { status: 'requested', claimedBy: null, claimedAt: null });
      }
    }
    const runs = this.runs.runs.map((run) => ({
      id: run.id,
      hasPullRequest: run.pullRequest !== null,
      hasRunBranch: run.workingCopy !== null,
    }));
    const claimed: ClaimedLookup[] = [];
    for (const lookup of rule.next(this.lookups, runs)) {
      const run = this.runs.runs.find((candidate) => candidate.id === lookup.runId);
      if (!run?.pullRequest || !run.workingCopy) continue;
      Object.assign(lookup, {
        status: 'claimed',
        claimedBy: workerId,
        claimedAt: rule.now,
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
        ...(lookup.kind === 'review_comments' && lookup.scope !== null
          ? {
              reviewComments: {
                scope: lookup.scope,
                ...(lookup.since === null ? {} : { since: lookup.since }),
              },
            }
          : {}),
      });
    }
    return Promise.resolve(claimed);
  }

  deleteFinishedBefore(before: Date): Promise<number> {
    const kept = this.lookups.filter(
      (lookup) => !(lookup.finishedAt !== null && lookup.finishedAt < before),
    );
    const removed = this.lookups.length - kept.length;
    this.lookups.splice(0, this.lookups.length, ...kept);
    return Promise.resolve(removed);
  }

  findReviewCommentsLoad(runId: string): Promise<ReviewCommentsLoad> {
    const own = this.lookups.filter(
      (lookup) => lookup.runId === runId && lookup.kind === 'review_comments',
    );
    const open = own.find((lookup) => lookup.status === 'requested' || lookup.status === 'claimed');
    const latest = own.reduce<FakeLookup | undefined>(
      (best, lookup) =>
        best === undefined || lookup.requestedAt.getTime() >= best.requestedAt.getTime()
          ? lookup
          : best,
      undefined,
    );
    return Promise.resolve({
      loading: open !== undefined,
      error: open?.error ?? (latest?.status === 'failed' ? latest.error : null),
    });
  }
}
