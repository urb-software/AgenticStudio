import { beforeEach, describe, expect, it } from 'vitest';
import { RunMergeReview } from '../../../../domain/entities/run-merge-review.js';
import { RunNotFoundError } from '../../../../domain/errors/run-errors.js';
import { deliveredRun, T0 } from '../../../../domain/repositories/__tests__/delivered-run.js';
import { InMemoryRunMergeReviewRepository } from '../../../../domain/repositories/__tests__/in-memory-run-merge-review-repository.js';
import { InMemoryRunRepository } from '../../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { LogRedaction } from '../../../../domain/value-objects/log-redaction.js';
import { GetMergeReviewHandler } from '../handler.js';

const REQUESTED = new Date(T0.getTime() + 60_000);
const LIMITS = {
  filesMax: 10,
  filePatchMaxBytes: 1000,
  patchMaxBytes: 10_000,
  totalMaxBytes: 10_000,
};
const RUN_COMMIT = 'b'.repeat(40);

describe('GetMergeReviewHandler', () => {
  let runs: InMemoryRunRepository;
  let reviews: InMemoryRunMergeReviewRepository;
  let now: Date;
  let runId: string;
  let get: GetMergeReviewHandler;

  const ready = () =>
    RunMergeReview.request(runId, REQUESTED).ready(
      {
        runCommit: RUN_COMMIT,
        integrationCommit: 'a'.repeat(40),
        files: [
          { path: 'src/a.txt', status: 'added', patch: '+a\n', cut: false },
          { path: 'bin.dat', status: 'added', binary: true, cut: false },
          { path: 'big.txt', status: 'added', cut: true },
        ],
        truncated: false,
        redaction: LogRedaction.NONE,
        limits: LIMITS,
      },
      REQUESTED,
    );

  const lookedAt = (commit: string, refreshedAt: Date) => {
    const run = runs.runs.find((candidate) => candidate.id === runId)!;
    run.pullRequestStatus = {
      ...run.pullRequestStatus,
      state: 'open',
      refreshedAt,
      checks: { commit, checks: [] },
    };
  };

  beforeEach(async () => {
    runs = new InMemoryRunRepository();
    reviews = new InMemoryRunMergeReviewRepository();
    now = new Date(T0.getTime() + 120_000);
    runId = (await deliveredRun(runs)).id;
    get = new GetMergeReviewHandler(runs, reviews, { now: () => now });
  });

  it('says none while no review was requested', async () => {
    await expect(get.execute({ runId })).resolves.toEqual({
      state: 'none',
      files: [],
      truncated: false,
    });
  });

  it('shows a preparing review, with nothing else', async () => {
    reviews.reviews.set(runId, RunMergeReview.request(runId, REQUESTED));

    await expect(get.execute({ runId })).resolves.toEqual({
      state: 'preparing',
      files: [],
      truncated: false,
    });
  });

  it('reads a review lost in a restart as failed: interrupted', async () => {
    reviews.reviews.set(runId, RunMergeReview.request(runId, REQUESTED));
    now = new Date(REQUESTED.getTime() + 16 * 60_000);

    await expect(get.execute({ runId })).resolves.toMatchObject({
      state: 'failed',
      failure: RunMergeReview.INTERRUPTED,
    });
  });

  it('lists a ready review’s files without their patches', async () => {
    reviews.reviews.set(runId, ready());

    const answer = await get.execute({ runId });

    expect(answer).toEqual({
      state: 'ready',
      runCommit: RUN_COMMIT,
      integrationCommit: 'a'.repeat(40),
      files: [
        { path: 'src/a.txt', status: 'added', cut: false },
        { path: 'bin.dat', status: 'added', binary: true, cut: false },
        { path: 'big.txt', status: 'added', cut: true },
      ],
      truncated: false,
    });
  });

  it('computes out_of_date on read from the pushed commit or the latest lookup', async () => {
    reviews.reviews.set(runId, ready());
    lookedAt(RUN_COMMIT, new Date(T0.getTime() + 90_000));
    expect((await get.execute({ runId })).state).toBe('ready');

    lookedAt('c'.repeat(40), new Date(T0.getTime() + 100_000));
    expect((await get.execute({ runId })).state).toBe('out_of_date');
  });

  it('names an unknown Run', async () => {
    const unknown = '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b';

    await expect(get.execute({ runId: unknown })).rejects.toBeInstanceOf(RunNotFoundError);
    await expect(get.execute({ runId: 'x' })).rejects.toBeInstanceOf(RunNotFoundError);
  });
});
