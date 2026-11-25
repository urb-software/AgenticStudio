import { beforeEach, describe, expect, it } from 'vitest';
import { PreviewMergeRebuild } from '../../../../domain/entities/preview-merge-rebuild.js';
import { InMemoryPreviewMergeRebuildRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-merge-rebuild-repository.js';
import { InMemoryPreviewOperationRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-operation-repository.js';
import { InMemoryPreviewSettingsRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-settings-repository.js';
import {
  KIT_NOW as NOW,
  savePreviewSettings,
  seedBuild,
} from '../../../__tests__/preview-test-kit.js';
import { GetPreviewOfMergeHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const RUN = '3c1d8f2a-0b2f-4d6e-8a44-6b3c1d8f2a10';
const NEWER_RUN = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
const OLD_BUILD = '0b2f6d52-3d0b-4d6e-8a44-6b3c1d8f2a10';
const MERGE_BUILD = '1c3a7e63-4e1c-4e7f-9b55-7c4d2e9a3b21';
const NEWER_BUILD = '2d4b8f74-5f2d-4f80-8c66-8d5e3f0b4c32';
const MERGED = 'e'.repeat(40);
const minutes = (count: number) => new Date(NOW.getTime() + count * 60_000);

describe('GetPreviewOfMergeHandler', () => {
  let settings: InMemoryPreviewSettingsRepository;
  let operations: InMemoryPreviewOperationRepository;
  let rebuilds: InMemoryPreviewMergeRebuildRepository;
  let handler: GetPreviewOfMergeHandler;

  beforeEach(() => {
    settings = new InMemoryPreviewSettingsRepository();
    operations = new InMemoryPreviewOperationRepository();
    rebuilds = new InMemoryPreviewMergeRebuildRepository();
    handler = new GetPreviewOfMergeHandler(settings, operations, rebuilds);
  });

  const stateFor = async (runId = RUN, mergedAt = minutes(0)) =>
    (await handler.execute({ projectId: PROJECT, runId, mergedCommit: MERGED, mergedAt })).state;
  const waiting = (runId: string) =>
    rebuilds.save(
      PreviewMergeRebuild.record({
        projectId: PROJECT,
        runId,
        mergedCommit: MERGED,
        mergedAt: NOW,
        fetchStartedAt: NOW,
        now: NOW,
      }),
    );
  it('is not configured without Preview settings', async () => {
    expect(await stateFor()).toBe('not_configured');
  });

  it('is not started when a configured Preview has nothing for the merge', async () => {
    await savePreviewSettings(settings, PROJECT);
    await seedBuild(operations, PROJECT, OLD_BUILD, 'succeeded', minutes(-10), 'a'.repeat(40));

    expect(await stateFor()).toBe('not_started');
  });

  it('waits while the rebuild of this Run waits, and says failed once it failed', async () => {
    await savePreviewSettings(settings, PROJECT);
    await waiting(RUN);

    expect(await stateFor()).toBe('waiting');

    const stored = await rebuilds.find(PROJECT);
    stored!.fail('refused', NOW);
    await rebuilds.saveFailure(stored!);
    expect(await stateFor()).toBe('failed');
  });

  it('is replaced for a Run whose rebuild a newer merge took over', async () => {
    await savePreviewSettings(settings, PROJECT);
    await waiting(NEWER_RUN);

    expect(await stateFor()).toBe('replaced');
    expect(await stateFor(NEWER_RUN)).toBe('waiting');
  });

  it('follows the build of the merged commit: building, then running, then replaced', async () => {
    await savePreviewSettings(settings, PROJECT);
    await seedBuild(operations, PROJECT, OLD_BUILD, 'succeeded', minutes(-10), 'a'.repeat(40));
    await seedBuild(operations, PROJECT, MERGE_BUILD, 'claimed', minutes(1), MERGED);
    expect(await stateFor()).toBe('building');

    await operations.change(MERGE_BUILD, (operation) => {
      operation.succeed('7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a', null, minutes(2));
    });
    expect(await stateFor()).toBe('running');

    await seedBuild(operations, PROJECT, NEWER_BUILD, 'succeeded', minutes(5), 'f'.repeat(40));
    expect(await stateFor()).toBe('replaced');
  });

  it('finds the build the merge started even when it built another commit than the merged one', async () => {
    await savePreviewSettings(settings, PROJECT);
    await seedBuild(operations, PROJECT, MERGE_BUILD, 'succeeded', minutes(1), 'c'.repeat(40), RUN);

    expect(await stateFor()).toBe('running');
    expect(await stateFor(NEWER_RUN, minutes(2))).toBe('not_started');
  });

  it('is failed when the build of the merged commit failed', async () => {
    await savePreviewSettings(settings, PROJECT);
    await seedBuild(operations, PROJECT, MERGE_BUILD, 'failed', minutes(1), MERGED);

    expect(await stateFor()).toBe('failed');
  });

  it('says replaced for a Run whose commit a later build of another Run replaced', async () => {
    await savePreviewSettings(settings, PROJECT);
    await seedBuild(operations, PROJECT, OLD_BUILD, 'succeeded', minutes(-10), 'a'.repeat(40));
    await seedBuild(
      operations,
      PROJECT,
      NEWER_BUILD,
      'succeeded',
      minutes(5),
      'f'.repeat(40),
      NEWER_RUN,
    );

    expect(await stateFor(RUN, minutes(0))).toBe('replaced');
    expect(await stateFor(RUN, minutes(5))).toBe('replaced');
    expect(await stateFor(RUN, minutes(6))).toBe('not_started');
    expect(await stateFor(NEWER_RUN, minutes(4))).toBe('running');
  });
});
