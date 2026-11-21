import { describe, expect, it } from 'vitest';
import { LogRedaction, REDACTED } from '../../value-objects/log-redaction.js';
import type { MergeReviewLimitsFacts } from '../run-merge-review-facts.js';
import { RunMergeReview } from '../run-merge-review.js';

const RUN = '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b';
const T0 = new Date('2026-11-21T10:00:00.000Z');
const minutes = (count: number) => new Date(T0.getTime() + count * 60_000);
const RUN_COMMIT = 'b'.repeat(40);
const LIMITS: MergeReviewLimitsFacts = {
  filesMax: 3,
  filePatchMaxBytes: 100,
  patchMaxBytes: 1000,
  totalMaxBytes: 1000,
};

const diff = (overrides: Partial<Parameters<RunMergeReview['ready']>[0]> = {}) => ({
  runCommit: RUN_COMMIT,
  integrationCommit: 'a'.repeat(40),
  files: [{ path: 'a.txt', status: 'added' as const, patch: '+a\n', cut: false }],
  truncated: false,
  redaction: LogRedaction.NONE,
  limits: LIMITS,
  ...overrides,
});

describe('RunMergeReview', () => {
  it('starts preparing, with nothing to show', () => {
    const review = RunMergeReview.request(RUN, T0);

    expect(review).toMatchObject({
      runId: RUN,
      storedState: 'preparing',
      files: [],
      completedAt: null,
      requestedAt: T0,
    });
    expect(review.stateAt(minutes(1), null)).toBe('preparing');
    expect(review.failureAt(minutes(1))).toBeNull();
  });

  it('reads a review still preparing after 15 minutes as failed: interrupted', () => {
    const review = RunMergeReview.request(RUN, T0);

    expect(review.stateAt(minutes(14), null)).toBe('preparing');
    expect(review.stateAt(minutes(16), null)).toBe('failed');
    expect(review.failureAt(minutes(16))).toBe(RunMergeReview.INTERRUPTED);
  });

  it('is ready with its commits, files and patches once the diff is in', () => {
    const review = RunMergeReview.request(RUN, T0).ready(diff(), minutes(1));

    expect(review.storedState).toBe('ready');
    expect(review.runCommit).toBe(RUN_COMMIT);
    expect(review.files.map((file) => file.path)).toEqual(['a.txt']);
    expect(review.file('a.txt')?.patch).toBe('+a\n');
    expect(review.file('nope')).toBeUndefined();
    expect(review.completedAt).toEqual(minutes(1));
    expect(review.stateAt(minutes(2), RUN_COMMIT)).toBe('ready');
  });

  it('is out of date once the Run branch left the reviewed commit, in any letter case', () => {
    const review = RunMergeReview.request(RUN, T0).ready(diff(), minutes(1));

    expect(review.stateAt(minutes(2), 'c'.repeat(40))).toBe('out_of_date');
    expect(review.stateAt(minutes(2), RUN_COMMIT.toUpperCase())).toBe('ready');
    expect(review.stateAt(minutes(2), null)).toBe('ready');
  });

  it('redacts the patches with the Run’s secret values', () => {
    const secret = 'hunter2-env-value';
    const review = RunMergeReview.request(RUN, T0).ready(
      diff({
        files: [{ path: '.env.example', status: 'added', patch: `+TOKEN=${secret}\n`, cut: false }],
        redaction: LogRedaction.of([secret]),
      }),
      minutes(1),
    );

    expect(review.file('.env.example')?.patch).toBe(`+TOKEN=${REDACTED}\n`);
    expect(JSON.stringify(review.files.map((file) => file.toData()))).not.toContain(secret);
  });

  it('leaves out a patch that redaction made longer than the file limit', () => {
    const secret = 'abcd';
    const review = RunMergeReview.request(RUN, T0).ready(
      diff({
        files: [{ path: 'x', status: 'added', patch: secret.repeat(20), cut: false }],
        redaction: LogRedaction.of([secret]),
        limits: { ...LIMITS, filePatchMaxBytes: 100 },
      }),
      minutes(1),
    );

    expect(review.file('x')).toMatchObject({ cut: true });
    expect(review.file('x')?.patch).toBeUndefined();
  });

  it('keeps at most the files limit and says the review is cut', () => {
    const files = ['a', 'b', 'c', 'd'].map((path) => ({
      path,
      status: 'added' as const,
      cut: false,
    }));

    const review = RunMergeReview.request(RUN, T0).ready(diff({ files }), minutes(1));

    expect(review.files.map((file) => file.path)).toEqual(['a', 'b', 'c']);
    expect(review.truncated).toBe(true);
  });

  it('leaves out the patches that no longer fit the total size, and says the review is cut', () => {
    const patch = 'x'.repeat(90);
    const files = ['a', 'b', 'c'].map((path) => ({
      path,
      status: 'added' as const,
      patch,
      cut: false,
    }));

    const review = RunMergeReview.request(RUN, T0).ready(
      diff({ files, limits: { ...LIMITS, totalMaxBytes: 400 } }),
      minutes(1),
    );

    expect(review.files.map((file) => file.patch !== undefined)).toEqual([true, true, false]);
    expect(review.files[2]?.cut).toBe(true);
    expect(review.truncated).toBe(true);
  });

  it('keeps what the diff said was cut', () => {
    const review = RunMergeReview.request(RUN, T0).ready(
      diff({ truncated: true, files: [{ path: 'a', status: 'added', cut: true }] }),
      minutes(1),
    );

    expect(review.truncated).toBe(true);
    expect(review.files[0]?.cut).toBe(true);
  });

  it('fails with a redacted reason cut to what is stored, and no files', () => {
    const secret = 'sup3r-secret-value';
    const review = RunMergeReview.request(RUN, T0).failed(
      `bad ${secret} ${'x'.repeat(3000)}`,
      LogRedaction.of([secret]),
      minutes(1),
    );

    expect(review.storedState).toBe('failed');
    expect(review.failure).toContain(REDACTED);
    expect(review.failure).not.toContain(secret);
    expect(review.failure).toHaveLength(RunMergeReview.FAILURE_MAX_LENGTH);
    expect(review.files).toEqual([]);
    expect(review.stateAt(minutes(2), RUN_COMMIT)).toBe('failed');
    expect(review.failureAt(minutes(2))).toBe(review.failure);
  });

  it('restores what it holds', () => {
    const ready = RunMergeReview.request(RUN, T0).ready(diff(), minutes(1));
    const data = {
      runId: ready.runId,
      state: ready.storedState,
      runCommit: ready.runCommit,
      integrationCommit: ready.integrationCommit,
      files: ready.files.map((file) => file.toData()),
      truncated: ready.truncated,
      failure: ready.failure,
      requestedAt: ready.requestedAt,
      completedAt: ready.completedAt,
    };

    expect(RunMergeReview.restore(data)).toEqual(ready);
  });
});
