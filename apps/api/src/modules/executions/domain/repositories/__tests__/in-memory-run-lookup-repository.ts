import { RunLookup, type RunLookupSnapshot } from '../../entities/run-lookup.js';
import type { LookupHandOutRule } from '../../value-objects/lookup-hand-out-rule.js';
import type { ReviewCommentsLoad } from '../../entities/run-lookup.js';
import type { LookupKind } from '../../value-objects/run-lookup.js';
import type { ClaimedLookup } from '../../entities/run-lookup.js';
import type { RunLookupRepository } from '../run-lookup-repository.js';
import type { InMemoryRunRepository } from './in-memory-run-repository.js';

/** A lookup as the fake keeps it: plain and mutable, so a test can set one up in any state. */
export type FakeLookup = {
  -readonly [K in keyof Omit<RunLookupSnapshot, 'result'>]: RunLookupSnapshot[K];
} & { result?: unknown };

const entity = (stored: FakeLookup): RunLookup =>
  RunLookup.restore({ ...stored, result: stored.result ?? null });

/**
 * In-memory adapter of {@link RunLookupRepository} for handler tests, with the database
 * adapter's rules: one open lookup per Run and kind, and the hand-out follows the
 * {@link LookupHandOutRule} over the lookups and their Runs in the given Run store. It stores
 * lookups only: what an answer does to the Run, the prepared Follow-up or the Review comments is
 * the transaction's, through their own fakes.
 */
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
    // A claim that outlived its lease goes back to the queue first, as the statement does.
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
    // The latest request; of equal times, the one recorded last.
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
