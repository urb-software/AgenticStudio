import { beforeEach, describe, expect, it } from 'vitest';
import { PreviewOperation } from '../../../../domain/entities/preview-operation.js';
import { InMemoryPreviewMergeRebuildRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-merge-rebuild-repository.js';
import { InMemoryPreviewOperationRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-operation-repository.js';
import { InMemoryPreviewSettingsRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-settings-repository.js';
import {
  KIT_CONTROLLER,
  KIT_NOW as NOW,
  savePreviewSettings,
  seedBuild,
} from '../../../__tests__/preview-test-kit.js';
import { RecordMergeRebuildHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const RUN = '3c1d8f2a-0b2f-4d6e-8a44-6b3c1d8f2a10';
const NEWER_RUN = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
const BUILD = '0b2f6d52-3d0b-4d6e-8a44-6b3c1d8f2a10';
const OTHER_BUILD = '1c3a7e63-4e1c-4e7f-9b55-7c4d2e9a3b21';
const STOP = '2d4b8f74-5f2d-4f80-8c66-8d5e3f0b4c32';
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

describe('RecordMergeRebuildHandler', () => {
  let settings: InMemoryPreviewSettingsRepository;
  let operations: InMemoryPreviewOperationRepository;
  let rebuilds: InMemoryPreviewMergeRebuildRepository;
  let handler: RecordMergeRebuildHandler;

  beforeEach(() => {
    settings = new InMemoryPreviewSettingsRepository();
    operations = new InMemoryPreviewOperationRepository();
    rebuilds = new InMemoryPreviewMergeRebuildRepository();
    handler = new RecordMergeRebuildHandler(settings, operations, rebuilds, { now: () => NOW });
  });

  const merge = (runId = RUN, mergedAt = at(-5)) => ({
    projectId: PROJECT,
    runId,
    mergedCommit: 'e'.repeat(40),
    mergedAt,
    fetchStartedAt: new Date(mergedAt.getTime() + 1000),
  });

  it('records the rebuild for a running Preview, with when it was recorded', async () => {
    await savePreviewSettings(settings, PROJECT);
    await seedBuild(operations, PROJECT, BUILD, 'succeeded');

    await expect(handler.execute(merge())).resolves.toEqual({ recorded: true });

    expect((await rebuilds.find(PROJECT))?.toData()).toEqual({
      projectId: PROJECT,
      runId: RUN,
      mergedCommit: 'e'.repeat(40),
      mergedAt: at(-5),
      fetchStartedAt: at(-4),
      recordedAt: NOW,
      failure: null,
      failedAt: null,
    });
  });

  it('records the rebuild for a Preview that builds', async () => {
    await savePreviewSettings(settings, PROJECT);
    await seedBuild(operations, PROJECT, BUILD, 'requested');

    await expect(handler.execute(merge())).resolves.toEqual({ recorded: true });
  });

  it('records nothing for a Preview that never ran, was stopped or failed', async () => {
    await savePreviewSettings(settings, PROJECT);
    await expect(handler.execute(merge())).resolves.toEqual({ recorded: false });

    await seedBuild(operations, PROJECT, BUILD, 'failed');
    await expect(handler.execute(merge())).resolves.toEqual({ recorded: false });

    await seedBuild(operations, PROJECT, OTHER_BUILD, 'succeeded', at(60));
    await operations.add(
      PreviewOperation.requestOther({ id: STOP, projectId: PROJECT, kind: 'stop', now: at(120) }),
    );
    await operations.change(STOP, (operation) => {
      operation.claim(KIT_CONTROLLER, at(121));
      operation.succeed(KIT_CONTROLLER, null, at(122));
    });
    await expect(handler.execute(merge())).resolves.toEqual({ recorded: false });

    expect(await rebuilds.find(PROJECT)).toBeNull();
  });

  it('records nothing for a Project without Preview settings', async () => {
    await expect(handler.execute(merge())).resolves.toEqual({ recorded: false });
  });

  it('lets the latest merge win, and clears an earlier failure', async () => {
    await savePreviewSettings(settings, PROJECT);
    await seedBuild(operations, PROJECT, BUILD, 'succeeded');
    await handler.execute(merge());
    const first = await rebuilds.find(PROJECT);
    first!.fail('earlier', NOW);
    await rebuilds.saveFailure(first!);

    await handler.execute(merge(NEWER_RUN, at(-1)));

    const stored = await rebuilds.find(PROJECT);
    expect(stored).toMatchObject({ runId: NEWER_RUN, isFailed: false });
    expect(await rebuilds.list()).toHaveLength(1);
  });
});
