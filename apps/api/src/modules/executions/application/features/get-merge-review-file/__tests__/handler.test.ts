import { beforeEach, describe, expect, it } from 'vitest';
import { RunMergeReview } from '../../../../domain/entities/run-merge-review.js';
import { RunNotFoundError } from '../../../../domain/errors/run-errors.js';
import { MergeReviewFileNotFoundError } from '../../../../domain/errors/run-merge-review-errors.js';
import { deliveredRun, T0 } from '../../../../domain/repositories/__tests__/delivered-run.js';
import { InMemoryRunMergeReviewRepository } from '../../../../domain/repositories/__tests__/in-memory-run-merge-review-repository.js';
import { InMemoryRunRepository } from '../../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { LogRedaction } from '../../../../domain/value-objects/log-redaction.js';
import { GetMergeReviewFileHandler } from '../handler.js';

const REQUESTED = new Date(T0.getTime() + 60_000);

describe('GetMergeReviewFileHandler', () => {
  let runs: InMemoryRunRepository;
  let reviews: InMemoryRunMergeReviewRepository;
  let runId: string;
  let handler: GetMergeReviewFileHandler;

  const ready = () =>
    RunMergeReview.request(runId, REQUESTED).ready(
      {
        runCommit: 'b'.repeat(40),
        integrationCommit: 'a'.repeat(40),
        files: [
          { path: 'src/a.txt', status: 'added', patch: '+a\n', cut: false },
          { path: 'bin.dat', status: 'added', binary: true, cut: false },
          { path: 'big.txt', status: 'added', cut: true },
          { path: 'new.txt', previousPath: 'old.txt', status: 'renamed', cut: false },
        ],
        truncated: false,
        redaction: LogRedaction.NONE,
        limits: {
          filesMax: 10,
          filePatchMaxBytes: 1000,
          patchMaxBytes: 10_000,
          totalMaxBytes: 10_000,
        },
      },
      REQUESTED,
    );

  beforeEach(async () => {
    runs = new InMemoryRunRepository();
    reviews = new InMemoryRunMergeReviewRepository();
    runId = (await deliveredRun(runs)).id;
    handler = new GetMergeReviewFileHandler(runs, reviews);
    reviews.reviews.set(runId, ready());
  });

  it('answers one file’s patch', async () => {
    await expect(handler.execute({ runId, path: 'src/a.txt' })).resolves.toEqual({
      path: 'src/a.txt',
      status: 'added',
      patch: '+a\n',
      cut: false,
    });
  });

  it('says why a file has no patch: binary, or cut by a limit', async () => {
    await expect(handler.execute({ runId, path: 'bin.dat' })).resolves.toEqual({
      path: 'bin.dat',
      status: 'added',
      binary: true,
      cut: false,
    });
    await expect(handler.execute({ runId, path: 'big.txt' })).resolves.toEqual({
      path: 'big.txt',
      status: 'added',
      cut: true,
    });
  });

  it('names the path a renamed file came from', async () => {
    await expect(handler.execute({ runId, path: 'new.txt' })).resolves.toMatchObject({
      previousPath: 'old.txt',
      status: 'renamed',
    });
  });

  it('refuses a file the review does not list, and any file while no review exists', async () => {
    await expect(handler.execute({ runId, path: 'nope.txt' })).rejects.toBeInstanceOf(
      MergeReviewFileNotFoundError,
    );
    reviews.reviews.clear();
    await expect(handler.execute({ runId, path: 'src/a.txt' })).rejects.toBeInstanceOf(
      MergeReviewFileNotFoundError,
    );
  });

  it('names an unknown Run, also for an id that is not a UUID', async () => {
    await expect(
      handler.execute({ runId: '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b', path: 'a' }),
    ).rejects.toBeInstanceOf(RunNotFoundError);
    await expect(handler.execute({ runId: 'x', path: 'a' })).rejects.toBeInstanceOf(
      RunNotFoundError,
    );
  });
});
