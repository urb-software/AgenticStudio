import { describe, expect, it } from 'vitest';
import { PreviewMergeRebuild } from '../preview-merge-rebuild.js';

const NOW = new Date('2026-11-24T10:00:00.000Z');
const LATER = new Date('2026-11-24T10:05:00.000Z');

const record = () =>
  PreviewMergeRebuild.record({
    projectId: '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e',
    runId: '3c1d8f2a-0b2f-4d6e-8a44-6b3c1d8f2a10',
    mergedCommit: 'e'.repeat(40),
    mergedAt: new Date('2026-11-24T09:59:00.000Z'),
    fetchStartedAt: new Date('2026-11-24T09:59:01.000Z'),
    now: NOW,
  });

describe('PreviewMergeRebuild', () => {
  it('is recorded waiting, with the merge and when it was recorded', () => {
    const rebuild = record();

    expect(rebuild).toMatchObject({
      mergedCommit: 'e'.repeat(40),
      recordedAt: NOW,
      isFailed: false,
      failure: null,
      failedAt: null,
    });
  });

  it('fails with a reason and the time, and keeps the first reason', () => {
    const rebuild = record();

    rebuild.fail('The Compose file was refused.', NOW);
    rebuild.fail('Another reason.', LATER);

    expect(rebuild).toMatchObject({
      isFailed: true,
      failure: 'The Compose file was refused.',
      failedAt: NOW,
    });
  });

  it('cuts a reason to what is stored', () => {
    const rebuild = record();

    rebuild.fail('x'.repeat(5000), NOW);

    expect(rebuild.failure).toHaveLength(2000);
  });

  it('restores from its data, failure included', () => {
    const rebuild = record();
    rebuild.fail('no', LATER);

    const restored = PreviewMergeRebuild.restore(rebuild.toData());

    expect(restored.toData()).toEqual(rebuild.toData());
    expect(restored.isFailed).toBe(true);
  });
});
