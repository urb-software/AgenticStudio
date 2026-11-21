import { beforeEach, describe, expect, it } from 'vitest';
import { RunNotFoundError } from '../../../../domain/errors/run-errors.js';
import { MergeReviewRefusedError } from '../../../../domain/errors/run-merge-review-errors.js';
import { InMemoryRunMergeReviewRepository } from '../../../../domain/repositories/__tests__/in-memory-run-merge-review-repository.js';
import { InMemoryRunRepository } from '../../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { deliveredRun, T0 } from '../../../../domain/repositories/__tests__/delivered-run.js';
import { LogRedaction } from '../../../../domain/value-objects/log-redaction.js';
import type { PullRequestState } from '../../../../domain/value-objects/pull-request-state.js';
import {
  FakeRunBranchReviews,
  FakeRunStartPoints,
} from '../../../__tests__/fake-run-branch-reviews.js';
import { RequestMergeReviewHandler } from '../handler.js';

const NOW = new Date(T0.getTime() + 60_000);

describe('RequestMergeReviewHandler', () => {
  let runs: InMemoryRunRepository;
  let reviews: InMemoryRunMergeReviewRepository;
  let branchReviews: FakeRunBranchReviews;
  let startPoints: FakeRunStartPoints;
  let now: Date;
  let handler: RequestMergeReviewHandler;

  const readAs = (runId: string, state: PullRequestState | null) => {
    const stored = runs.runs.find((candidate) => candidate.id === runId)!;
    stored.pullRequestStatus = { ...stored.pullRequestStatus, state, refreshedAt: T0 };
  };

  beforeEach(() => {
    runs = new InMemoryRunRepository();
    reviews = new InMemoryRunMergeReviewRepository();
    branchReviews = new FakeRunBranchReviews();
    startPoints = new FakeRunStartPoints();
    now = NOW;
    handler = new RequestMergeReviewHandler(runs, reviews, startPoints, branchReviews, {
      now: () => now,
    });
  });

  it('claims a preparing review for a Run with an open pull request', async () => {
    const run = await deliveredRun(runs);

    await expect(handler.execute({ runId: run.id })).resolves.toEqual({ requestedAt: NOW });

    expect(reviews.reviews.get(run.id)).toMatchObject({
      storedState: 'preparing',
      requestedAt: NOW,
    });
  });

  it.each(['draft', 'open', null] as const)('accepts a pull request that is %s', async (state) => {
    const run = await deliveredRun(runs);
    readAs(run.id, state);

    await expect(handler.execute({ runId: run.id })).resolves.toBeDefined();
  });

  it.each(['merged', 'closed', 'missing'] as const)(
    'refuses with pull_request_not_open when the pull request is %s',
    async (state) => {
      const run = await deliveredRun(runs);
      readAs(run.id, state);

      await expect(handler.execute({ runId: run.id })).rejects.toEqual(
        new MergeReviewRefusedError('pull_request_not_open'),
      );
      expect(reviews.reviews.size).toBe(0);
    },
  );

  it('refuses with no_pull_request for a Run that opened none', async () => {
    const run = await deliveredRun(runs, { delivered: false });

    await expect(handler.execute({ runId: run.id })).rejects.toEqual(
      new MergeReviewRefusedError('no_pull_request'),
    );
  });

  it('refuses with repository_not_ready while the Project’s Repository is not ready', async () => {
    const run = await deliveredRun(runs);
    startPoints.point = { status: 'repository_not_ready' };

    await expect(handler.execute({ runId: run.id })).rejects.toEqual(
      new MergeReviewRefusedError('repository_not_ready'),
    );
    startPoints.point = { status: 'no_repository' };
    await expect(handler.execute({ runId: run.id })).rejects.toEqual(
      new MergeReviewRefusedError('repository_not_ready'),
    );
  });

  it('refuses with unsupported_platform when the API does not run on Linux', async () => {
    const run = await deliveredRun(runs);
    branchReviews.platformSupported = false;

    await expect(handler.execute({ runId: run.id })).rejects.toEqual(
      new MergeReviewRefusedError('unsupported_platform'),
    );
    expect(reviews.reviews.size).toBe(0);
  });

  it('refuses with review_in_progress while a review is preparing, and takes a new one after', async () => {
    const run = await deliveredRun(runs);
    await handler.execute({ runId: run.id });

    await expect(handler.execute({ runId: run.id })).rejects.toEqual(
      new MergeReviewRefusedError('review_in_progress'),
    );

    const stored = reviews.reviews.get(run.id)!;
    reviews.reviews.set(run.id, stored.failed('x', LogRedaction.NONE, NOW));
    now = new Date(NOW.getTime() + 1000);
    await expect(handler.execute({ runId: run.id })).resolves.toEqual({ requestedAt: now });
  });

  it('takes a new review over a preparing one that is 15 minutes old (an API restart)', async () => {
    const run = await deliveredRun(runs);
    await handler.execute({ runId: run.id });
    now = new Date(NOW.getTime() + 16 * 60_000);

    await expect(handler.execute({ runId: run.id })).resolves.toEqual({ requestedAt: now });
  });

  it('names an unknown Run, also for an id that is not a UUID', async () => {
    await expect(handler.execute({ runId: 'not-a-uuid' })).rejects.toBeInstanceOf(RunNotFoundError);
    await expect(
      handler.execute({ runId: '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b' }),
    ).rejects.toBeInstanceOf(RunNotFoundError);
  });
});
