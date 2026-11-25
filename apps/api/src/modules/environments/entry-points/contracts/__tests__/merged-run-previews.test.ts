import { describe, expect, it, vi } from 'vitest';
import type { GetPreviewOfMergeHandler } from '../../../application/features/get-preview-of-merge/handler.js';
import type { RecordMergeRebuildHandler } from '../../../application/features/record-merge-rebuild/handler.js';
import { EnvironmentsMergedRunPreviews } from '../merged-run-previews.js';

const MERGE = {
  projectId: '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e',
  runId: '3c1d8f2a-0b2f-4d6e-8a44-6b3c1d8f2a10',
  mergedCommit: 'e'.repeat(40),
  mergedAt: new Date('2026-11-24T10:00:00.000Z'),
  fetchStartedAt: new Date('2026-11-24T10:00:01.000Z'),
};

function adapter(options: {
  record?: () => Promise<{ recorded: boolean }>;
  read?: () => Promise<{ state: 'running' }>;
}) {
  const record = vi.fn(options.record ?? (() => Promise.resolve({ recorded: true })));
  const read = vi.fn(options.read ?? (() => Promise.resolve({ state: 'running' as const })));
  return {
    record,
    read,
    previews: new EnvironmentsMergedRunPreviews(
      { execute: record } as unknown as RecordMergeRebuildHandler,
      { execute: read } as unknown as GetPreviewOfMergeHandler,
    ),
  };
}

describe('EnvironmentsMergedRunPreviews', () => {
  it('maps a merge to the record handler', async () => {
    const { previews, record } = adapter({});

    await previews.merged(MERGE);

    expect(record).toHaveBeenCalledWith(MERGE);
  });

  it('never throws when recording fails', async () => {
    const { previews } = adapter({ record: () => Promise.reject(new Error('database is down')) });

    await expect(previews.merged(MERGE)).resolves.toBeUndefined();
  });

  it('maps a read to the handler and answers its state', async () => {
    const { previews, read } = adapter({});

    await expect(
      previews.forMerge(MERGE.projectId, MERGE.runId, MERGE.mergedCommit, MERGE.mergedAt),
    ).resolves.toEqual({ state: 'running' });
    expect(read).toHaveBeenCalledWith({
      projectId: MERGE.projectId,
      runId: MERGE.runId,
      mergedCommit: MERGE.mergedCommit,
      mergedAt: MERGE.mergedAt,
    });
  });
});
