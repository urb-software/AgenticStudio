import { beforeEach, describe, expect, it } from 'vitest';
import { RunMergeReview } from '../../../../domain/entities/run-merge-review.js';
import { deliveredRun, T0 } from '../../../../domain/repositories/__tests__/delivered-run.js';
import { InMemoryRunMergeReviewRepository } from '../../../../domain/repositories/__tests__/in-memory-run-merge-review-repository.js';
import { InMemoryRunRepository } from '../../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { REDACTED } from '../../../../domain/value-objects/log-redaction.js';
import { FakeRunBranchReviews } from '../../../__tests__/fake-run-branch-reviews.js';
import { PrepareMergeReviewHandler } from '../handler.js';

const LIMITS = {
  filesMax: 1000,
  filePatchMaxBytes: 512 * 1024,
  patchMaxBytes: 4 * 1024 * 1024,
  totalMaxBytes: 5 * 1024 * 1024,
};
const REQUESTED = new Date(T0.getTime() + 60_000);
const DONE = new Date(T0.getTime() + 120_000);

describe('PrepareMergeReviewHandler', () => {
  let runs: InMemoryRunRepository;
  let reviews: InMemoryRunMergeReviewRepository;
  let branchReviews: FakeRunBranchReviews;
  let known: string[];
  let handler: PrepareMergeReviewHandler;
  let runId: string;

  const stored = () => reviews.reviews.get(runId)!;
  const prepare = (requestedAt = REQUESTED) => handler.execute({ runId, requestedAt });

  beforeEach(async () => {
    runs = new InMemoryRunRepository();
    reviews = new InMemoryRunMergeReviewRepository();
    branchReviews = new FakeRunBranchReviews();
    known = [];
    handler = new PrepareMergeReviewHandler(
      runs,
      reviews,
      branchReviews,
      { forRun: () => Promise.resolve(known) },
      LIMITS,
      { now: () => DONE },
    );
    runId = (await deliveredRun(runs)).id;
    reviews.reviews.set(runId, RunMergeReview.request(runId, REQUESTED));
  });

  it('fetches the Run’s own branch, computes the merge diff and stores a ready review', async () => {
    await prepare();

    expect(branchReviews.fetchForReview).toHaveBeenCalledWith(
      expect.any(String),
      runId,
      'agent/x-r0b8e5c2d',
    );
    expect(branchReviews.mergeDiff).toHaveBeenCalledWith(
      expect.any(String),
      runId,
      'b'.repeat(40),
      'a'.repeat(40),
      expect.objectContaining({ filesMax: 1000, filePatchMaxBytes: 512 * 1024 }),
    );
    expect(stored()).toMatchObject({
      storedState: 'ready',
      runCommit: 'b'.repeat(40),
      integrationCommit: 'a'.repeat(40),
      completedAt: DONE,
    });
    expect(stored().file('src/a.txt')?.patch).toBe('+a\n');
  });

  it('redacts the Run’s secret values out of the patches before storing them', async () => {
    known = ['hunter2-env-value'];
    branchReviews.mergeDiff.mockResolvedValue({
      status: 'computed',
      files: [
        {
          path: 'config.ts',
          status: 'added',
          patch: '+const t = "hunter2-env-value";\n',
          cut: false,
        },
      ],
      truncated: false,
    });

    await prepare();

    expect(stored().file('config.ts')?.patch).toBe(`+const t = "${REDACTED}";\n`);
  });

  it('stores a conflict with the Integration branch as a failed review', async () => {
    branchReviews.mergeDiff.mockResolvedValue({ status: 'conflicting' });

    await prepare();

    expect(stored()).toMatchObject({
      storedState: 'failed',
      failure: RunMergeReview.CONFLICTS,
    });
  });

  it.each([
    ['repository_not_ready', /Repository is not ready/],
    ['branch_not_found', /Run branch no longer exists/],
    ['unsupported_platform', /Linux/],
  ] as const)('stores a failed fetch (%s) as the failure', async (status, message) => {
    branchReviews.fetchForReview.mockResolvedValue({ status });

    await prepare();

    expect(stored().storedState).toBe('failed');
    expect(stored().failure).toMatch(message);
    expect(branchReviews.mergeDiff).not.toHaveBeenCalled();
  });

  it('stores Git’s redacted detail of a failed fetch or diff', async () => {
    branchReviews.fetchForReview.mockResolvedValueOnce({ status: 'failed', detail: 'denied' });
    await prepare();
    expect(stored().failure).toBe('Studio could not fetch the Run branch: denied');

    reviews.reviews.set(runId, RunMergeReview.request(runId, REQUESTED));
    branchReviews.mergeDiff.mockResolvedValueOnce({ status: 'failed', detail: 'bad object' });
    await prepare();
    expect(stored().failure).toBe('Studio could not compute the merge result: bad object');
  });

  it('stores an unexpected error as a failed review instead of throwing', async () => {
    branchReviews.fetchForReview.mockRejectedValue(new Error('boom'));

    await expect(prepare()).resolves.toBeUndefined();

    expect(stored()).toMatchObject({
      storedState: 'failed',
      failure: 'The review could not be prepared.',
    });
  });

  it('drops the result of a request that a newer one replaced', async () => {
    const newer = new Date(REQUESTED.getTime() + 5_000);
    reviews.reviews.set(runId, RunMergeReview.request(runId, newer));

    await prepare(REQUESTED);

    expect(stored()).toMatchObject({ storedState: 'preparing', requestedAt: newer });
    expect(branchReviews.fetchForReview).not.toHaveBeenCalled();
  });

  it('does nothing for a review that already has an outcome', async () => {
    await prepare();
    branchReviews.fetchForReview.mockClear();

    await prepare();

    expect(branchReviews.fetchForReview).not.toHaveBeenCalled();
  });

  it('lists a patch over the file limit without it', async () => {
    branchReviews.mergeDiff.mockResolvedValue({
      status: 'computed',
      files: [
        {
          path: 'big.txt',
          status: 'added',
          patch: 'x'.repeat(LIMITS.filePatchMaxBytes + 1),
          cut: false,
        },
      ],
      truncated: false,
    });

    await prepare();

    expect(stored().file('big.txt')).toMatchObject({ cut: true });
    expect(stored().file('big.txt')?.patch).toBeUndefined();
  });
});
